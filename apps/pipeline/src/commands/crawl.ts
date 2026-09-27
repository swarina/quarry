import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createPoliteFetcher } from "@quarry/crawl";
import { openPipelineStore } from "@quarry/storage/node";
import { positiveNumber, requireOption, writeOut } from "../cli.ts";
import { PRODUCT_TOKEN, runIdentity, userAgent } from "../config.ts";
import { type CrawlReport, crawlBoards } from "../crawl.ts";
import { FRESHNESS_WINDOW_MS, summarizeFreshness } from "../freshness.ts";
import { createLogger } from "../log.ts";
import { parseDenylist, parseSeeds } from "../seeds.ts";
import { buildRunStats, renderSummary } from "../summary.ts";

export const CRAWL_HELP = `  crawl                    Crawl every active board into the pipeline store.
    --store <path>           SQLite store to update, created if missing (required)
    --seeds <dir>            Directory with boards.yaml and denylist.yaml (default: seeds)
    --budget-minutes <n>     Start no board after this many minutes (default: 40)
    --max-boards <n>         Crawl at most this many boards
    --summary <path>         Append a Markdown run summary, for example $GITHUB_STEP_SUMMARY
    --stats <path>           Write run statistics as JSON
`;

const NO_CRAWL: CrawlReport = {
  due: 0,
  attempted: 0,
  deferred: 0,
  outcomes: { listed: 0, "not-modified": 0, failed: 0, "not-found": 0, "board-gone": 0 },
};

export async function crawlCommand(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      store: { type: "string" },
      seeds: { type: "string", default: "seeds" },
      "budget-minutes": { type: "string", default: "40" },
      "max-boards": { type: "string" },
      summary: { type: "string" },
      stats: { type: "string" },
    },
    strict: true,
  });
  const storePath = requireOption(values.store, "--store");
  const budgetMinutes = positiveNumber(values["budget-minutes"], "--budget-minutes");
  const maxBoards =
    values["max-boards"] === undefined
      ? undefined
      : positiveNumber(values["max-boards"], "--max-boards");

  const seeds = parseSeeds(await readFile(join(values.seeds, "boards.yaml"), "utf8"));
  const denied = parseDenylist(await readFile(join(values.seeds, "denylist.yaml"), "utf8"));

  const startedAt = Date.now();
  const identity = runIdentity(startedAt);
  const log = createLogger("pipeline", writeOut);
  const store = openPipelineStore(storePath);
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("Run interrupted by a signal"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);

  try {
    store.startRun({
      id: identity.runId,
      trigger: identity.trigger,
      codeVersion: identity.codeVersion,
      startedAt,
    });
    const sync = store.syncBoards(seeds, denied, startedAt);
    log.info("run started", { run_id: identity.runId, boards: seeds.length });
    log.info("boards synced", {
      run_id: identity.runId,
      boards_added: sync.added,
      boards_reactivated: sync.reactivated,
      boards_retired: sync.retired,
      boards_denied: sync.denied,
      postings_purged: sync.purgedPostings,
    });

    const fetcher = createPoliteFetcher({
      userAgent: userAgent(identity.codeVersion),
      productToken: PRODUCT_TOKEN,
    });
    let status: "succeeded" | "failed" = "failed";
    let report = NO_CRAWL;
    try {
      report = await crawlBoards(
        { store, fetcher, log, now: Date.now },
        {
          runId: identity.runId,
          deadline: startedAt + budgetMinutes * 60_000,
          ...(maxBoards === undefined ? {} : { maxBoards }),
          signal: controller.signal,
        },
      );
      status = "succeeded";
    } finally {
      const finishedAt = Date.now();
      store.finishRun(identity.runId, status, finishedAt);
      const stats = buildRunStats({
        runId: identity.runId,
        startedAt,
        finishedAt,
        status,
        crawl: report,
        summary: store.runSummary(identity.runId),
        freshness: summarizeFreshness(
          store.freshnessSamples(finishedAt - FRESHNESS_WINDOW_MS),
          identity.runId,
        ),
        hosts: fetcher.stats(),
      });
      if (values.stats !== undefined) {
        await writeFile(values.stats, `${JSON.stringify(stats, null, 2)}\n`);
      }
      if (values.summary !== undefined) await appendFile(values.summary, renderSummary(stats));
      log.info("run finished", {
        run_id: identity.runId,
        outcome: status,
        duration_ms: finishedAt - startedAt,
        boards: report.attempted,
      });
    }
    return 0;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    store.close();
  }
}
