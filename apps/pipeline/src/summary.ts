import type { HostStats } from "@quarry/crawl";
import { formatUsd } from "@quarry/jev";
import type { CrawlOutcome, RunSummary, SnapshotManifest, StoreReport } from "@quarry/storage/node";
import type { CrawlReport } from "./crawl.ts";
import type { EnrichReport } from "./enrich.ts";
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

/**
 * What the enrichment stage did, or would do when `report` is null (a dry run). The cost is
 * always stated, because this is the only part of the pipeline that spends money.
 */
export function renderEnrichment(
  report: EnrichReport | null,
  estimate: {
    readonly outstanding: number;
    readonly perPostingNanoUsd: number;
    readonly totalNanoUsd: number;
  },
  budgetUsd: number,
): string {
  const number = (value: number) => value.toLocaleString("en-US");
  const lines = [
    "### Answers to the standard questions",
    "",
    `- ${number(estimate.outstanding)} postings had no answers: about ${formatUsd(estimate.perPostingNanoUsd)} each, ${formatUsd(estimate.totalNanoUsd)} for all of them.`,
  ];
  if (report === null) {
    lines.push(
      `- Nothing was asked and nothing was spent; the budget would have been $${budgetUsd.toFixed(2)}.`,
    );
    return `${lines.join("\n")}\n\n`;
  }
  lines.push(
    `- Asked about ${number(report.asked)}, answered ${number(report.answered)}, failed ${number(report.failed)}.`,
    `- Spent ${formatUsd(report.costNanoUsd)} of $${budgetUsd.toFixed(2)}: ${number(report.inputTokens)} input and ${number(report.outputTokens)} output tokens.`,
    `- Stopped because: ${report.stoppedBy}.`,
  );
  if (report.errors.length > 0) {
    lines.push(
      "",
      "| Posting | Error |",
      "| --- | --- |",
      ...report.errors.map((error) => `| \`${error.postingId}\` | ${escapeCell(error.message)} |`),
    );
  }
  return `${lines.join("\n")}\n\n`;
}

/** What `store pull` restored, as Markdown; `manifest` is null for a store started empty. */
export function renderRestore(manifest: SnapshotManifest | null, durationMs: number): string {
  const text =
    manifest === null
      ? "Started an empty store: the release holds no snapshot yet."
      : `Restored snapshot ${manifest.seq} (made ${manifest.createdAt} by run \`${manifest.runId}\`, schema version ${manifest.schemaVersion}): ${formatBytes(manifest.snapshot.bytes)} downloaded and ${formatBytes(manifest.sqliteBytes)} restored in ${formatDuration(durationMs)}.`;
  return `### Store restore\n\n${text}\n\n`;
}

/** A `store verify` report as Markdown. */
export function renderStoreReport(report: StoreReport): string {
  const healthy = report.integrity.length === 1 && report.integrity[0] === "ok";
  const boards = Object.entries(report.boards)
    .map(([status, count]) => `${count.toLocaleString("en-US")} ${status}`)
    .join(", ");
  const lastRun =
    report.lastRun === null
      ? "none"
      : `\`${report.lastRun.id}\` (${report.lastRun.status}), started ${new Date(report.lastRun.startedAt).toISOString()}`;
  return [
    "### Store check",
    "",
    "| Integrity | Schema version | Snapshot | Boards | Postings | Crawls | Last run |",
    "| --- | ---: | ---: | --- | ---: | ---: | --- |",
    `| ${healthy ? "ok" : escapeCell(report.integrity.slice(0, 3).join("; "))} | ${report.schemaVersion} | ${report.snapshotSeq} | ${boards || "none"} | ${report.postings.toLocaleString("en-US")} | ${report.crawls.toLocaleString("en-US")} | ${lastRun} |`,
    "",
    "",
  ].join("\n");
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
