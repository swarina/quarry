import { costNanoUsd, formatUsd, type JevClient, JevError } from "@quarry/jev";
import { postingState, questionsVersion, standardQuestions } from "@quarry/questions";
import type { PipelineStore, StoredAnswer, UnansweredPosting } from "@quarry/storage/node";
import type { Logger } from "./log.ts";

export interface EnrichReport {
  /** Postings whose current content lacked an answer when the run started. */
  readonly outstanding: number;
  readonly asked: number;
  readonly answered: number;
  readonly failed: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costNanoUsd: number;
  /** Why the run stopped, so a short run is never mistaken for a finished one. */
  readonly stoppedBy: "nothing outstanding" | "budget" | "limit" | "deadline" | "errors";
  readonly errors: readonly { readonly postingId: string; readonly message: string }[];
}

/** Failures in a row that say the problem is not this posting, so the run stops rather than burns budget. */
const CONSECUTIVE_FAILURES = 5;
/** Errors listed in the report; the rest are counted only. */
const ERRORS_SHOWN = 10;

export interface EnrichOptions {
  readonly store: PipelineStore;
  readonly client: JevClient;
  readonly runId: string;
  /** Most postings to ask about, whatever the budget allows. */
  readonly maxPostings: number;
  /** Stop starting new requests once this much has been spent in this run. */
  readonly budgetNanoUsd: number;
  /** Stop starting new requests after this time, so a run cannot overrun its workflow. */
  readonly deadline: number;
  readonly concurrency: number;
  readonly log: Logger;
  readonly now?: () => number;
}

/**
 * Answers the standard questions about postings whose current content has no answers yet.
 *
 * Every question about a posting goes in one request, because the posting's text is the
 * expensive part and is shared; postings are never packed together, which measurement showed
 * changes the answers (ADR-0025). Answers are keyed on the content hash,
 * so an edited posting is asked again and an unchanged one is never paid for twice.
 */
export async function enrichPostings(options: EnrichOptions): Promise<EnrichReport> {
  const { store, client, log } = options;
  const now = options.now ?? Date.now;
  const questions = standardQuestions();
  const wanted = questionsVersion().split(",");
  const outstanding = store.unansweredCount(wanted);
  const startedAt = now();

  const totals = { asked: 0, answered: 0, failed: 0, input: 0, output: 0, cost: 0 };
  const errors: { postingId: string; message: string }[] = [];
  let consecutive = 0;
  let stoppedBy: EnrichReport["stoppedBy"] = "nothing outstanding";

  const postings = store.unanswered(wanted, Math.min(options.maxPostings, outstanding));
  if (postings.length < outstanding) stoppedBy = "limit";

  const queue = [...postings];
  const askOne = async (posting: UnansweredPosting): Promise<void> => {
    const result = await client.ask({
      purpose: "enrichment",
      state: postingState({
        title: posting.title,
        company: posting.company,
        locations: posting.locations,
        description: posting.description,
      }),
      questions,
    });
    const answeredAt = now();
    const answers: StoredAnswer[] = Object.entries(result.answers).map(([id, answer]) => ({
      contentHash: posting.contentHash,
      questionId: id,
      questionVersion: Number(
        wanted.find((entry) => entry.startsWith(`${id}@`))?.split("@")[1] ?? 1,
      ),
      model: result.model,
      answeredAt,
      answerJson: JSON.stringify(answer),
    }));
    store.saveAnswers(answers);
    totals.answered += 1;
    totals.input += result.usage.inputTokens;
    totals.output += result.usage.outputTokens;
    totals.cost += result.usage.costNanoUsd;
    consecutive = 0;
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (totals.cost >= options.budgetNanoUsd) {
        stoppedBy = "budget";
        return;
      }
      if (now() >= options.deadline) {
        stoppedBy = "deadline";
        return;
      }
      if (consecutive >= CONSECUTIVE_FAILURES) {
        stoppedBy = "errors";
        return;
      }
      const posting = queue.shift();
      if (posting === undefined) return;
      totals.asked += 1;
      try {
        await askOne(posting);
      } catch (caught) {
        totals.failed += 1;
        consecutive += 1;
        const message =
          caught instanceof JevError
            ? `${caught.code}: ${caught.message}`
            : caught instanceof Error
              ? caught.message
              : String(caught);
        if (errors.length < ERRORS_SHOWN) errors.push({ postingId: posting.id, message });
        log.warn("posting not answered", { posting_id: posting.id, error_message: message });
        // A spend limit refusing a request is the budget speaking, not this posting.
        if (caught instanceof JevError && caught.code === "BUDGET_EXCEEDED") {
          stoppedBy = "budget";
          return;
        }
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, worker));

  const finishedAt = now();
  store.recordEnrichment({
    runId: options.runId,
    startedAt,
    finishedAt,
    asked: totals.asked,
    failed: totals.failed,
    inputTokens: totals.input,
    outputTokens: totals.output,
    costNanoUsd: totals.cost,
  });
  log.info("postings enriched", {
    run_id: options.runId,
    outstanding,
    asked: totals.asked,
    answered: totals.answered,
    failed: totals.failed,
    cost_usd: formatUsd(totals.cost),
    stopped_by: stoppedBy,
  });

  return {
    outstanding,
    asked: totals.asked,
    answered: totals.answered,
    failed: totals.failed,
    inputTokens: totals.input,
    outputTokens: totals.output,
    costNanoUsd: totals.cost,
    stoppedBy,
    errors,
  };
}

/**
 * What answering every outstanding posting would cost, before anything is spent. The estimate
 * uses the same price the client charges against the budget, over the text that would be sent.
 */
export function estimateEnrichment(
  store: PipelineStore,
  sample: number,
): {
  readonly outstanding: number;
  readonly perPostingNanoUsd: number;
  readonly totalNanoUsd: number;
} {
  const wanted = questionsVersion().split(",");
  const outstanding = store.unansweredCount(wanted);
  const postings = store.unanswered(wanted, Math.min(sample, outstanding));
  if (postings.length === 0) return { outstanding, perPostingNanoUsd: 0, totalNanoUsd: 0 };
  const questions = JSON.stringify(standardQuestions());
  const encoder = new TextEncoder();
  const tokens = postings.reduce((total, posting) => {
    const state = JSON.stringify(postingState(posting));
    return total + Math.ceil((encoder.encode(state + questions).length + 1) / 4);
  }, 0);
  const perPosting = costNanoUsd(Math.round(tokens / postings.length));
  return { outstanding, perPostingNanoUsd: perPosting, totalNanoUsd: perPosting * outstanding };
}
