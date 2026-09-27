import type { HostStats } from "@quarry/crawl";
import type { CrawlOutcome, RunSummary } from "@quarry/storage/node";
import type { CrawlReport } from "./crawl.ts";
import type { Freshness, FreshnessStats } from "./freshness.ts";

export interface RunStats {
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly status: "succeeded" | "failed";
  readonly crawl: CrawlReport;
  /** Share of attempted boards whose crawl gave a usable listing (listed or not modified). */
  readonly successRate: number | null;
  readonly summary: RunSummary;
  readonly freshness: Freshness;
  readonly hosts: Readonly<Record<string, HostStats>>;
}

const SUCCESS: ReadonlySet<CrawlOutcome> = new Set(["listed", "not-modified"]);

export function buildRunStats(input: {
  readonly runId: string;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly status: "succeeded" | "failed";
  readonly crawl: CrawlReport;
  readonly summary: RunSummary;
  readonly freshness: Freshness;
  readonly hosts: ReadonlyMap<string, HostStats>;
}): RunStats {
  const succeeded = input.summary.bySource
    .filter((row) => SUCCESS.has(row.outcome))
    .reduce((total, row) => total + row.crawls, 0);
  const attempted = input.summary.bySource.reduce((total, row) => total + row.crawls, 0);
  return {
    runId: input.runId,
    startedAt: new Date(input.startedAt).toISOString(),
    finishedAt: new Date(input.finishedAt).toISOString(),
    durationMs: input.finishedAt - input.startedAt,
    status: input.status,
    crawl: input.crawl,
    successRate: attempted === 0 ? null : succeeded / attempted,
    summary: input.summary,
    freshness: input.freshness,
    hosts: Object.fromEntries(input.hosts),
  };
}

const OUTCOME_COLUMNS: readonly [CrawlOutcome, string][] = [
  ["listed", "Listed"],
  ["not-modified", "Unchanged"],
  ["failed", "Failed"],
  ["not-found", "Not found"],
  ["board-gone", "Gone"],
];

/** Failed boards shown in the summary; the full list is in the stats file. */
const FAILURES_SHOWN = 50;

/** The run summary as Markdown, for the GitHub Actions job summary. */
export function renderSummary(stats: RunStats): string {
  const { summary } = stats;
  const sources = [...new Set(summary.bySource.map((row) => row.source))].sort();
  const cell = (
    source: string | undefined,
    pick: (row: RunSummary["bySource"][number]) => number,
  ) =>
    summary.bySource
      .filter((row) => source === undefined || row.source === source)
      .reduce((total, row) => total + pick(row), 0);
  const line = (label: string, source: string | undefined) =>
    `| ${label} | ${[
      ...OUTCOME_COLUMNS.map(([outcome]) =>
        cell(source, (row) => (row.outcome === outcome ? row.crawls : 0)),
      ),
      cell(source, (row) => row.newPostings),
      cell(source, (row) => row.changedPostings),
      cell(source, (row) => row.invalid),
    ]
      .map((value) => value.toLocaleString("en-US"))
      .join(" | ")} |`;

  const lines = [
    `## Crawl run \`${stats.runId}\` (${stats.status})`,
    "",
    `| Source | ${OUTCOME_COLUMNS.map(([, label]) => label).join(" | ")} | New postings | Changed | Invalid jobs |`,
    `| --- | ${OUTCOME_COLUMNS.map(() => "---:").join(" | ")} | ---: | ---: | ---: |`,
    ...sources.map((source) => line(source, source)),
    line("**All**", undefined),
    "",
    `- Crawl success: ${formatRate(stats.successRate)} of ${stats.crawl.attempted.toLocaleString("en-US")} boards attempted; ${stats.crawl.deferred.toLocaleString("en-US")} deferred to the next run.`,
    `- Active boards: ${summary.activeBoards.toLocaleString("en-US")}. Postings in the latest listings: ${summary.listedPostings.toLocaleString("en-US")}. Postings ever seen: ${summary.knownPostings.toLocaleString("en-US")}.`,
    `- Requests: ${sum(stats.hosts, "requests").toLocaleString("en-US")} (${sum(stats.hosts, "retries").toLocaleString("en-US")} retries), ${formatBytes(sum(stats.hosts, "bytes"))} downloaded, in ${formatDuration(stats.durationMs)}.`,
    ...renderFreshness(stats.freshness),
  ];

  if (summary.failures.length > 0) {
    lines.push(
      "",
      `### Boards that failed (${summary.failures.length})`,
      "",
      "| Board | Outcome | HTTP | Error |",
      "| --- | --- | ---: | --- |",
      ...summary.failures
        .slice(0, FAILURES_SHOWN)
        .map(
          (failure) =>
            `| \`${failure.boardId}\` | ${failure.outcome} | ${failure.httpStatus ?? ""} | ${escapeCell(
              [failure.errorCode, failure.errorMessage].filter(Boolean).join(": "),
            )} |`,
        ),
    );
    if (summary.failures.length > FAILURES_SHOWN) {
      lines.push("", `And ${summary.failures.length - FAILURES_SHOWN} more in the stats file.`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function renderFreshness(freshness: Freshness): string[] {
  const window = `Last ${freshness.windowDays} days`;
  const row = (label: string, stats: FreshnessStats) =>
    `| ${label} | ${stats.postings.toLocaleString("en-US")} | ${stats.timed.toLocaleString("en-US")} | ${formatHours(stats.p50Hours)} | ${formatHours(stats.p95Hours)} |`;
  return [
    "",
    "### Freshness of new postings",
    "",
    "Time from the publish time an ATS states to our first sighting, for new postings on boards we had listed before. Lever only states when a posting was created, which can be earlier.",
    "",
    "| First seen | New postings | With a publish time | Median | 95th percentile |",
    "| --- | ---: | ---: | ---: | ---: |",
    row("This run", freshness.run),
    row(window, freshness.window),
    ...Object.entries(freshness.bySource).map(([source, stats]) =>
      row(`${window}, ${source}`, stats),
    ),
  ];
}

function sum(hosts: RunStats["hosts"], field: "requests" | "retries" | "bytes"): number {
  return Object.values(hosts).reduce((total, host) => total + host[field], 0);
}

function formatRate(rate: number | null): string {
  return rate === null ? "n/a" : `${(rate * 100).toFixed(1)}%`;
}

function formatHours(hours: number | null): string {
  return hours === null ? "n/a" : `${hours.toFixed(1)} h`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 200);
}
