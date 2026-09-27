import { listingRequest, NORMALIZER_VERSION } from "@quarry/ats";
import type { FetchOutcome, GetOptions, PoliteFetcher } from "@quarry/crawl";
import { boardId } from "@quarry/domain";
import { openPipelineStore, type PipelineStore, type SeedBoard } from "@quarry/storage/node";
import { beforeEach, describe, expect, it } from "vitest";
import { type CrawlOptions, crawlBoards } from "./crawl.ts";
import { createLogger } from "./log.ts";

const SEEDS: SeedBoard[] = [
  { source: "greenhouse", slug: "acme", company: "Acme", country: "US" },
  { source: "lever", slug: "beta", company: "Beta", country: "FR" },
  { source: "ashby", slug: "gamma", company: "Gamma", country: "GB" },
];

const url = (seed: SeedBoard) => listingRequest(seed.source, seed.slug).url;
const [ACME, BETA, GAMMA] = SEEDS as [SeedBoard, SeedBoard, SeedBoard];

const greenhouseBody = (ids: number[]) =>
  JSON.stringify({
    jobs: ids.map((id) => ({
      id,
      title: `Engineer ${id}`,
      absolute_url: `https://job-boards.greenhouse.io/acme/jobs/${id}`,
      content: "&lt;p&gt;Build things.&lt;/p&gt;",
      location: { name: "Remote" },
    })),
  });

const leverBody = (ids: string[]) =>
  JSON.stringify(
    ids.map((id) => ({
      id,
      text: `Designer ${id}`,
      hostedUrl: `https://jobs.lever.co/beta/${id}`,
      description: "<p>Design things.</p>",
    })),
  );

type Script = Record<string, FetchOutcome | ((options: GetOptions) => FetchOutcome)>;

/** A fetcher that answers from a script and records what it was asked. */
function scriptedFetcher(script: Script, onGet?: (url: string) => void) {
  const calls: { url: string; etag: string | null | undefined }[] = [];
  const fetcher: PoliteFetcher = {
    async get(target, options = {}) {
      calls.push({ url: target, etag: options.etag });
      onGet?.(target);
      const reply = script[target];
      if (reply === undefined) throw new Error(`Unscripted request: ${target}`);
      return typeof reply === "function" ? reply(options) : reply;
    },
    stats: () => new Map(),
  };
  return { fetcher, calls };
}

const ok = (body: string, etag: string | null = null): FetchOutcome => ({
  kind: "ok",
  status: 200,
  body,
  etag,
  bytes: body.length,
  attempts: 1,
});

let store: PipelineStore;
let clock: number;
let runs = 0;
const lines: string[] = [];

async function crawl(fetcher: PoliteFetcher, options: Partial<CrawlOptions> = {}) {
  runs += 1;
  const runId = `run-${runs}`;
  store.startRun({ id: runId, trigger: "local", codeVersion: "test", startedAt: clock });
  const log = createLogger(
    "test",
    (line) => lines.push(line),
    () => clock,
  );
  return crawlBoards(
    { store, fetcher, log, now: () => clock },
    { runId, deadline: clock + 60_000, ...options },
  );
}

beforeEach(() => {
  runs = 0;
  store = openPipelineStore(":memory:");
  store.syncBoards(SEEDS, [], 0);
  clock = Date.UTC(2026, 8, 27, 3, 17);
  lines.length = 0;
});

describe("crawlBoards", () => {
  it("records listings from every source and reports the outcomes", async () => {
    const { fetcher } = scriptedFetcher({
      [url(ACME)]: ok(greenhouseBody([1, 2]), 'W/"a"'),
      [url(BETA)]: ok(leverBody(["x"])),
      [url(GAMMA)]: { kind: "not-found", status: 404, attempts: 1 },
    });
    expect(await crawl(fetcher)).toEqual({
      due: 3,
      attempted: 3,
      deferred: 0,
      outcomes: { listed: 2, "not-modified": 0, failed: 0, "not-found": 1, "board-gone": 0 },
    });
    expect(store.board(boardId("greenhouse", "acme"))).toMatchObject({
      lastListedCount: 2,
      etag: 'W/"a"',
      etagNormalizerVersion: NORMALIZER_VERSION,
    });
    const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(logged.filter((line) => line["msg"] === "board crawled")).toHaveLength(3);
    expect(logged.every((line) => line["run_id"] === "run-1")).toBe(true);
  });

  it("revalidates with the stored ETag and records 304s as unchanged", async () => {
    const first = scriptedFetcher({
      [url(ACME)]: ok(greenhouseBody([1, 2]), 'W/"a"'),
      [url(BETA)]: ok(leverBody(["x"])),
      [url(GAMMA)]: { kind: "not-found", status: 404, attempts: 1 },
    });
    await crawl(first.fetcher);
    const second = scriptedFetcher({
      [url(ACME)]: (options) =>
        options.etag === 'W/"a"' ? { kind: "not-modified", attempts: 1 } : ok(greenhouseBody([1])),
      [url(BETA)]: ok(leverBody(["x", "y"])),
      [url(GAMMA)]: { kind: "not-found", status: 404, attempts: 1 },
    });
    const report = await crawl(second.fetcher);
    expect(report.outcomes).toMatchObject({ listed: 1, "not-modified": 1, "not-found": 1 });
    expect(second.calls.find((call) => call.url === url(ACME))?.etag).toBe('W/"a"');
    // Lever sent no ETag, and a never-listed board has nothing to revalidate.
    expect(second.calls.find((call) => call.url === url(BETA))?.etag).toBeNull();
    expect(second.calls.find((call) => call.url === url(GAMMA))?.etag).toBeNull();
    expect(store.board(boardId("greenhouse", "acme"))?.lastListedCount).toBe(2);
  });

  it("ignores an ETag stored by an older normalizer", async () => {
    await crawl(
      scriptedFetcher({
        [url(ACME)]: ok(greenhouseBody([1]), 'W/"a"'),
        [url(BETA)]: ok(leverBody(["x"])),
        [url(GAMMA)]: ok(JSON.stringify({ jobs: [] })),
      }).fetcher,
    );
    store.db.exec("UPDATE boards SET etag_normalizer_version = etag_normalizer_version - 1");
    const { fetcher, calls } = scriptedFetcher({
      [url(ACME)]: ok(greenhouseBody([1]), 'W/"a"'),
      [url(BETA)]: ok(leverBody(["x"])),
      [url(GAMMA)]: ok(JSON.stringify({ jobs: [] })),
    });
    await crawl(fetcher);
    expect(calls.find((call) => call.url === url(ACME))?.etag).toBeNull();
  });

  it("records unreadable responses as failures with a reason", async () => {
    const { fetcher } = scriptedFetcher({
      [url(ACME)]: ok("<html>maintenance</html>"),
      [url(BETA)]: ok(JSON.stringify({ ok: false })),
      [url(GAMMA)]: {
        kind: "failed",
        failure: "server-error",
        status: 503,
        message: "HTTP 503",
        attempts: 3,
      },
    });
    const report = await crawl(fetcher);
    expect(report.outcomes.failed).toBe(3);
    const failures = store
      .runSummary("run-1")
      .failures.map((failure) => [failure.boardId, failure.errorCode]);
    expect(failures).toEqual([
      ["ashby:gamma", "server-error"],
      ["greenhouse:acme", "invalid-json"],
      ["lever:beta", "schema-drift"],
    ]);
  });

  it("records skipped boards as failures, so success rates stay honest", async () => {
    const skipped: FetchOutcome = { kind: "skipped", reason: "robots-unreachable" };
    const { fetcher } = scriptedFetcher({
      [url(ACME)]: skipped,
      [url(BETA)]: skipped,
      [url(GAMMA)]: skipped,
    });
    await crawl(fetcher);
    expect(store.runSummary("run-1").failures.map((failure) => failure.errorCode)).toEqual([
      "robots-unreachable",
      "robots-unreachable",
      "robots-unreachable",
    ]);
  });

  it("logs schema problems for jobs that fail validation", async () => {
    const body = JSON.stringify({
      jobs: [{ id: 1, title: "Broken", content: "x", absolute_url: "nope" }],
    });
    const { fetcher } = scriptedFetcher({
      [url(ACME)]: ok(body),
      [url(BETA)]: ok(leverBody([])),
      [url(GAMMA)]: ok(JSON.stringify({ jobs: [] })),
    });
    await crawl(fetcher);
    const warnings = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line["level"] === "warn");
    expect(warnings).toEqual([
      expect.objectContaining({
        msg: "job failed validation",
        board_id: "greenhouse:acme",
        error_message: expect.stringMatching(/^1: absolute_url: /),
      }),
    ]);
  });

  it("starts no board after the deadline and leaves the rest due", async () => {
    // Three boards on one host run one after another, and each request takes 40 s.
    const sameHost: SeedBoard[] = ["one", "two", "three"].map((slug) => ({
      source: "greenhouse",
      slug,
      company: slug,
      country: null,
    }));
    store.syncBoards(sameHost, [], 0);
    const script = Object.fromEntries(sameHost.map((seed) => [url(seed), ok(greenhouseBody([1]))]));
    const { fetcher, calls } = scriptedFetcher(script, () => {
      clock += 40_000;
    });
    const report = await crawl(fetcher, { deadline: clock + 60_000 });
    expect(report).toMatchObject({ due: 3, attempted: 2, deferred: 1 });
    // Never-crawled boards go in id order: one, three, two.
    expect(calls.map((call) => call.url)).toEqual([
      listingRequest("greenhouse", "one").url,
      listingRequest("greenhouse", "three").url,
    ]);
    expect(store.activeBoards()[0]?.slug).toBe("two");
  });

  it("crawls at most maxBoards, least recently crawled first", async () => {
    const { fetcher, calls } = scriptedFetcher({
      [url(ACME)]: ok(greenhouseBody([1])),
      [url(BETA)]: ok(leverBody(["x"])),
      [url(GAMMA)]: ok(JSON.stringify({ jobs: [] })),
    });
    await crawl(fetcher, { maxBoards: 2 });
    expect(calls.map((call) => call.url)).toEqual([url(GAMMA), url(ACME)]);
    await crawl(fetcher, { maxBoards: 1 });
    expect(calls.at(-1)?.url).toBe(url(BETA));
  });

  it("stops at the next board when the run is aborted, keeping finished work", async () => {
    const controller = new AbortController();
    const { fetcher } = scriptedFetcher({
      [url(ACME)]: () => {
        controller.abort(new Error("cancelled"));
        return ok(greenhouseBody([1]));
      },
      [url(BETA)]: ok(leverBody(["x"])),
      [url(GAMMA)]: ok(JSON.stringify({ jobs: [] })),
    });
    await expect(crawl(fetcher, { signal: controller.signal, maxBoards: 3 })).rejects.toThrow(
      "cancelled",
    );
    expect(store.board(boardId("greenhouse", "acme"))?.lastListedCount).toBe(1);
  });
});
