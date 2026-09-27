import type { RunSummary } from "@quarry/storage/node";
import { describe, expect, it } from "vitest";
import type { CrawlReport } from "./crawl.ts";
import type { Freshness } from "./freshness.ts";
import { buildRunStats, renderSummary } from "./summary.ts";

const crawl: CrawlReport = {
  due: 4,
  attempted: 4,
  deferred: 0,
  outcomes: { listed: 2, "not-modified": 1, failed: 1, "not-found": 0, "board-gone": 0 },
};

const summary: RunSummary = {
  runId: "gh-1-1",
  bySource: [
    {
      source: "ashby",
      outcome: "failed",
      crawls: 1,
      newPostings: 0,
      changedPostings: 0,
      invalid: 0,
      bytes: 0,
      attempts: 3,
    },
    {
      source: "greenhouse",
      outcome: "listed",
      crawls: 2,
      newPostings: 1_200,
      changedPostings: 3,
      invalid: 1,
      bytes: 2_000_000,
      attempts: 2,
    },
    {
      source: "greenhouse",
      outcome: "not-modified",
      crawls: 1,
      newPostings: 0,
      changedPostings: 0,
      invalid: 0,
      bytes: 0,
      attempts: 1,
    },
  ],
  failures: [
    {
      boardId: "ashby:beta",
      outcome: "failed",
      httpStatus: 503,
      errorCode: "server-error",
      errorMessage: "HTTP | 503",
    },
  ],
  activeBoards: 4,
  listedPostings: 1_500,
  knownPostings: 1_600,
};

const hosts = new Map([
  [
    "api.ashbyhq.com",
    {
      requests: 4,
      retries: 2,
      failures: 1,
      bytes: 100,
      circuitOpen: false,
      breakerTrips: 0,
      robots: "allowed-all" as const,
      crawlDelaySeconds: undefined,
    },
  ],
  [
    "boards-api.greenhouse.io",
    {
      requests: 4,
      retries: 0,
      failures: 0,
      bytes: 2_097_152,
      circuitOpen: false,
      breakerTrips: 0,
      robots: "parsed" as const,
      crawlDelaySeconds: undefined,
    },
  ],
]);

const freshness: Freshness = {
  windowDays: 7,
  run: { postings: 12, timed: 11, p50Hours: 9.5, p95Hours: 22 },
  window: { postings: 80, timed: 78, p50Hours: 11.2, p95Hours: 40.3 },
  bySource: {
    greenhouse: { postings: 70, timed: 68, p50Hours: 10.8, p95Hours: 30 },
    lever: { postings: 10, timed: 10, p50Hours: 20, p95Hours: 300.4 },
  },
};

const stats = buildRunStats({
  runId: "gh-1-1",
  startedAt: Date.UTC(2026, 8, 27, 3, 17),
  finishedAt: Date.UTC(2026, 8, 27, 3, 20, 5),
  status: "succeeded",
  crawl,
  summary,
  freshness,
  hosts,
});

describe("buildRunStats", () => {
  it("computes the success rate over attempted crawls", () => {
    expect(stats.successRate).toBe(0.75);
    expect(stats.durationMs).toBe(185_000);
    expect(stats.startedAt).toBe("2026-09-27T03:17:00.000Z");
    expect(Object.keys(stats.hosts)).toEqual(["api.ashbyhq.com", "boards-api.greenhouse.io"]);
  });

  it("has no success rate when nothing was attempted", () => {
    expect(
      buildRunStats({
        ...stats,
        startedAt: 0,
        finishedAt: 0,
        summary: { ...summary, bySource: [] },
        hosts,
      }).successRate,
    ).toBeNull();
  });
});

describe("renderSummary", () => {
  const markdown = renderSummary(stats);

  it("tabulates outcomes per source with a total row", () => {
    expect(markdown).toContain("## Crawl run `gh-1-1` (succeeded)");
    expect(markdown).toContain("| ashby | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 |");
    expect(markdown).toContain("| greenhouse | 2 | 1 | 0 | 0 | 0 | 1,200 | 3 | 1 |");
    expect(markdown).toContain("| **All** | 2 | 1 | 1 | 0 | 0 | 1,200 | 3 | 1 |");
  });

  it("states success, corpus size, and traffic", () => {
    expect(markdown).toContain("Crawl success: 75.0% of 4 boards attempted; 0 deferred");
    expect(markdown).toContain("Postings in the latest listings: 1,500");
    expect(markdown).toContain("Requests: 8 (2 retries), 2.0 MB downloaded, in 3 min 5 s.");
  });

  it("reports freshness for the run, the window, and each source", () => {
    expect(markdown).toContain("### Freshness of new postings");
    expect(markdown).toContain("| This run | 12 | 11 | 9.5 h | 22.0 h |");
    expect(markdown).toContain("| Last 7 days | 80 | 78 | 11.2 h | 40.3 h |");
    expect(markdown).toContain("| Last 7 days, lever | 10 | 10 | 20.0 h | 300.4 h |");
    const empty = renderSummary({
      ...stats,
      freshness: { ...freshness, run: { postings: 0, timed: 0, p50Hours: null, p95Hours: null } },
    });
    expect(empty).toContain("| This run | 0 | 0 | n/a | n/a |");
  });

  it("lists failed boards with escaped cells", () => {
    expect(markdown).toContain("### Boards that failed (1)");
    expect(markdown).toContain("| `ashby:beta` | failed | 503 | server-error: HTTP \\| 503 |");
  });
});
