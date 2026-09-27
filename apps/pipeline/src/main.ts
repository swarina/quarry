import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createPoliteFetcher } from "@quarry/crawl";
import { openPipelineStore } from "@quarry/storage/node";
import { PRODUCT_TOKEN, runIdentity, userAgent } from "./config.ts";
import { type CrawlReport, crawlBoards } from "./crawl.ts";
import { createLogger } from "./log.ts";
import { parseDenylist, parseSeeds, SeedsError } from "./seeds.ts";
import { buildRunStats, renderSummary } from "./summary.ts";

const HELP = `Usage: pipeline <command> [options]

Commands:
  crawl     Crawl every active board into the pipeline store.

Options for crawl:
  --store <path>           SQLite store to update, created if missing (required)
  --seeds <dir>            Directory with boards.yaml and denylist.yaml (default: seeds)
  --budget-minutes <n>     Start no board after this many minutes (default: 40)
  --max-boards <n>         Crawl at most this many boards
  --summary <path>         Append a Markdown run summary, for example $GITHUB_STEP_SUMMARY
  --stats <path>           Write run statistics as JSON
`;

class UsageError extends Error {
  override readonly name = "UsageError";
}

const write = (line: string) => {
  process.stdout.write(line);
};

async function crawlCommand(args: readonly string[]): Promise<number> {
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
  if (values.store === undefined) throw new UsageError("--store is required");
  const budgetMinutes = positiveNumber(values["budget-minutes"], "--budget-minutes");
  const maxBoards =
    values["max-boards"] === undefined
      ? undefined
      : positiveNumber(values["max-boards"], "--max-boards");

  const seeds = parseSeeds(await readFile(join(values.seeds, "boards.yaml"), "utf8"));
  const denied = parseDenylist(await readFile(join(values.seeds, "denylist.yaml"), "utf8"));

  const startedAt = Date.now();
  const identity = runIdentity(startedAt);
  const log = createLogger("pipeline", write);
  const store = openPipelineStore(values.store);
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
    let report: CrawlReport = {
      due: 0,
      attempted: 0,
      deferred: 0,
      outcomes: { listed: 0, "not-modified": 0, failed: 0, "not-found": 0, "board-gone": 0 },
    };
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
        hosts: fetcher.stats(),
      });
      if (values.stats !== undefined)
        await writeFile(values.stats, `${JSON.stringify(stats, null, 2)}\n`);
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

function positiveNumber(value: string, flag: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0)
    throw new UsageError(`${flag} must be a positive number`);
  return number;
}

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...args] = argv;
  try {
    switch (command) {
      case "crawl":
        return await crawlCommand(args);
      case "help":
      case "--help":
        write(HELP);
        return 0;
      default:
        process.stderr.write(
          `${command === undefined ? "Missing command" : `Unknown command: ${command}`}\n\n${HELP}`,
        );
        return 2;
    }
  } catch (error) {
    if (error instanceof UsageError || error instanceof SeedsError || isArgumentError(error)) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 2;
    }
    throw error;
  }
}

function isArgumentError(error: unknown): boolean {
  return (
    error instanceof TypeError && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS")
  );
}

process.exitCode = await main(process.argv.slice(2));
