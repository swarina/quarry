import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createJevClient, createRateLimiter, createSpendLimit, formatUsd } from "@quarry/jev";
import { createJsonlLedger } from "@quarry/jev/node";
import { STANDARD_QUESTIONS } from "@quarry/questions";
import { openPipelineStore } from "@quarry/storage/node";
import { positiveNumber, requireOption, writeOut } from "../cli.ts";
import { jevKey, runIdentity } from "../config.ts";
import { enrichPostings, estimateEnrichment } from "../enrich.ts";
import { createLogger } from "../log.ts";
import { renderEnrichment } from "../summary.ts";

export const ENRICH_HELP = `  enrich                   Answer the standard questions about postings that have no answers.
    --store <path>           Store to read and write (required)
    --budget-usd <n>         Most to spend in this run (default: 1.00)
    --max-postings <n>       Most postings to ask about (default: all outstanding)
    --minutes <n>            Start no request after this many minutes (default: 20)
    --ledger <path>          Append every request's cost here (default: <store dir>/ledger.jsonl)
    --dry-run                Report what it would ask and what it would cost, and spend nothing
    --summary <path>         Append a Markdown summary, for example $GITHUB_STEP_SUMMARY
`;

/** Postings sampled to estimate the cost of the rest. */
const ESTIMATE_SAMPLE = 100;
const REQUESTS_PER_MINUTE = 300;
const CONCURRENCY = 6;

export async function enrichCommand(args: readonly string[]): Promise<number> {
  const { values } = parseArguments(args);
  const storePath = requireOption(values.store, "--store");
  const budgetUsd = positiveNumber(values["budget-usd"] ?? "1.00", "--budget-usd");
  const minutes = positiveNumber(values.minutes ?? "20", "--minutes");
  const maxPostings =
    values["max-postings"] === undefined
      ? Number.POSITIVE_INFINITY
      : positiveNumber(values["max-postings"], "--max-postings");

  const startedAt = Date.now();
  const identity = runIdentity(startedAt);
  const log = createLogger("pipeline", writeOut);
  const store = openPipelineStore(storePath);
  try {
    const estimate = estimateEnrichment(store, ESTIMATE_SAMPLE);
    writeOut(
      `${STANDARD_QUESTIONS.length} questions, ${estimate.outstanding.toLocaleString("en-US")} postings without answers\n` +
        `  about ${formatUsd(estimate.perPostingNanoUsd)} each, ${formatUsd(estimate.totalNanoUsd)} for all of them\n` +
        `  this run would spend at most ${formatUsd(Math.round(budgetUsd * 1e9))}\n`,
    );
    if (values["dry-run"] === true) {
      if (values.summary !== undefined) {
        await appendFile(values.summary, renderEnrichment(null, estimate, budgetUsd));
      }
      return 0;
    }

    // An enrichment is a run like a crawl, so it is recorded as one and its spend hangs off it.
    store.startRun({
      id: identity.runId,
      trigger: identity.trigger,
      codeVersion: identity.codeVersion,
      startedAt,
    });
    const ledgerPath = values.ledger ?? join(storePath, "..", "ledger.jsonl");
    const ledger = createJsonlLedger(ledgerPath);
    const spendLimit = createSpendLimit({ limitNanoUsd: Math.round(budgetUsd * 1e9) });
    const client = createJevClient({
      apiKey: jevKey(),
      ledger,
      spendLimit,
      rateLimiter: createRateLimiter({
        requestsPerMinute: REQUESTS_PER_MINUTE,
        maxConcurrent: CONCURRENCY,
      }),
    });

    const report = await enrichPostings({
      store,
      client,
      runId: identity.runId,
      maxPostings,
      budgetNanoUsd: Math.round(budgetUsd * 1e9),
      deadline: startedAt + minutes * 60_000,
      concurrency: CONCURRENCY,
      log,
    });
    const failedRun = report.asked > 0 && report.answered === 0;
    store.finishRun(identity.runId, failedRun ? "failed" : "succeeded", Date.now());
    writeOut(
      `Answered ${report.answered.toLocaleString("en-US")} postings for ${formatUsd(report.costNanoUsd)}` +
        `${report.failed > 0 ? `, ${report.failed} failed` : ""} (${report.stoppedBy})\n`,
    );
    if (values.summary !== undefined) {
      await appendFile(values.summary, renderEnrichment(report, estimate, budgetUsd));
    }
    // Some postings failing is normal; none answered when some were asked is not.
    return failedRun ? 1 : 0;
  } finally {
    store.close();
  }
}

function parseArguments(args: readonly string[]) {
  return parseArgs({
    args: [...args],
    options: {
      store: { type: "string" },
      "budget-usd": { type: "string" },
      "max-postings": { type: "string" },
      minutes: { type: "string" },
      ledger: { type: "string" },
      "dry-run": { type: "boolean" },
      summary: { type: "string" },
    },
    strict: true,
  });
}
