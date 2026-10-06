import { readAnswer } from "@quarry/facets";
import { costNanoUsd, type JevClient, JevError } from "@quarry/jev";
import type { Criterion } from "./criterion.ts";
import type { AnswerCache, PostingSource, PostingText } from "./ports.ts";

/**
 * Asking criteria of the postings a search left.
 *
 * Only what the filters leave is asked, which is what makes a brand new question cost cents
 * instead of dollars: a few hundred postings rather than the whole corpus. The cache is read
 * first, so a question someone already asked about the same text is free, and the answers go
 * back into it, so the second person pays nothing either.
 */

/** One criterion's answer about one posting, in the shape the site reads standard answers in. */
export interface CriterionAnswer {
  readonly criterionId: string;
  /** A probability per option, in hundredths, in the criterion's own option order. */
  readonly distribution: readonly number[];
  /** True when this came from the cache rather than from a request made now. */
  readonly cached: boolean;
}

export interface PostingAnswers {
  readonly id: string;
  readonly answers: readonly CriterionAnswer[];
}

/** Why a run stopped, so a partial answer is never mistaken for a complete one. */
export type StoppedBy = "finished" | "budget" | "deadline" | "errors";

export interface AskReport {
  /** Postings the request named that the source could resolve. */
  readonly postings: number;
  /** Distinct texts among them: what is actually paid for (ADR-0024). */
  readonly texts: number;
  /** Criterion-and-posting pairs wanted in total. */
  readonly wanted: number;
  /** Pairs already in the cache, which cost nothing. */
  readonly cached: number;
  /** Requests made, which is one per distinct text that was missing something. */
  readonly asked: number;
  readonly failed: number;
  readonly costNanoUsd: number;
  readonly stoppedBy: StoppedBy;
  /** Pairs still unanswered when the run stopped. */
  readonly outstanding: number;
  readonly errors: readonly string[];
}

export interface AskOptions {
  readonly criteria: readonly Criterion[];
  /** Posting id prefixes, as the browser has them from the search index. */
  readonly idPrefixes: readonly string[];
  readonly postings: PostingSource;
  readonly cache: AnswerCache;
  readonly client: JevClient;
  /**
   * The most this request should spend, in nano-dollars, used to decide how many requests to
   * start. It is not the hard cap: the cost of a request is only known once it comes back, so
   * an estimate that understates it can overshoot by the requests in flight. The exact cap is
   * the spend limit inside the client (ADR-0005), which the caller sets to the same allowance.
   */
  readonly allowanceNanoUsd: number;
  /** Stop starting requests after this moment. */
  readonly deadline: number;
  readonly concurrency: number;
  readonly now?: () => number;
}

export interface AskResult {
  readonly answers: readonly PostingAnswers[];
  readonly report: AskReport;
}

/** Failures in a row that say the problem is not this posting. Mirrors the enrichment stage. */
const CONSECUTIVE_FAILURES = 5;
/** Errors reported; the rest are counted only. */
const ERRORS_SHOWN = 5;

/** The answer kind the facets layer reads a criterion's answers as. */
function kindOf(criterion: Criterion): "choice" | "score" | "noul" {
  return criterion.kind === "yes-no" ? "noul" : criterion.kind === "scale" ? "score" : "choice";
}

/**
 * Estimates what one request will cost, over the text that would actually be sent.
 *
 * Four characters to a token is a rough heuristic, the same one the enrichment stage's estimate
 * uses. It is deliberately an estimate rather than the upper bound the spend limiter reserves:
 * this decides how many requests to start, and the limiter is what makes the cap exact.
 */
function estimateNanoUsd(posting: PostingText, criteria: readonly Criterion[]): number {
  const state = JSON.stringify({
    posting: {
      title: posting.title,
      company: posting.company,
      locations: posting.locations,
      description: posting.description,
    },
  });
  const questions = JSON.stringify(
    Object.fromEntries(criteria.map((criterion) => [criterion.id, criterion.question])),
  );
  const bytes = new TextEncoder().encode(state + questions).byteLength;
  return costNanoUsd(Math.ceil((bytes + 1) / 4));
}

/**
 * One unit of work: a distinct text, the postings that share it, and the criteria it has no
 * answer for.
 *
 * Grouping by text rather than by posting is what makes a repost free. Two postings with the
 * same content hash are one request, and both get the answer, because the cache is keyed on
 * content and not on the posting (ADR-0024).
 */
interface TextUnit {
  readonly contentHash: string;
  /** Any posting with this text; they all read the same to the model. */
  readonly posting: PostingText;
  readonly postingIds: readonly string[];
  readonly missing: readonly Criterion[];
}

/** Groups postings by their text, and reads the cache once per criterion for all of them. */
async function planUnits(
  postings: readonly PostingText[],
  criteria: readonly Criterion[],
  cache: AnswerCache,
  model: string,
): Promise<{
  readonly units: readonly TextUnit[];
  /** Readable cached answers, by content hash. */
  readonly held: Map<string, CriterionAnswer[]>;
}> {
  const byHash = new Map<string, PostingText[]>();
  for (const posting of postings) {
    const sharing = byHash.get(posting.contentHash) ?? [];
    sharing.push(posting);
    byHash.set(posting.contentHash, sharing);
  }
  const hashes = [...byHash.keys()];

  // One cache read per criterion covering every text, rather than one per posting.
  const held = new Map<string, CriterionAnswer[]>();
  const answered = new Map<string, Set<string>>();
  for (const criterion of criteria) {
    const found = await cache.read(criterion.id, model, hashes);
    const seen = new Set<string>();
    for (const entry of found) {
      seen.add(entry.contentHash);
      // A stored answer is whatever some model returned, so it is read through the facets
      // layer. One that does not read cleanly counts as missing, never as a wrong answer.
      const distribution = readAnswer(entry.answerJson, kindOf(criterion), criterion.options);
      if (distribution === null) continue;
      const forHash = held.get(entry.contentHash) ?? [];
      forHash.push({ criterionId: criterion.id, distribution, cached: true });
      held.set(entry.contentHash, forHash);
    }
    answered.set(criterion.id, seen);
  }

  const units: TextUnit[] = [];
  for (const [contentHash, sharing] of byHash) {
    const first = sharing[0];
    if (first === undefined) continue;
    units.push({
      contentHash,
      posting: first,
      postingIds: sharing.map((posting) => posting.id),
      missing: criteria.filter((criterion) => !answered.get(criterion.id)?.has(contentHash)),
    });
  }
  return { units, held };
}

/** What asking every missing pair would cost, without spending anything. */
export async function estimateAsk(options: {
  readonly criteria: readonly Criterion[];
  readonly idPrefixes: readonly string[];
  readonly postings: PostingSource;
  readonly cache: AnswerCache;
  readonly model: string;
}): Promise<{
  readonly postings: number;
  readonly texts: number;
  readonly wanted: number;
  readonly cached: number;
  readonly toAsk: number;
  readonly nanoUsd: number;
}> {
  const resolved = await options.postings.read(options.idPrefixes);
  const { units, held } = await planUnits(resolved, options.criteria, options.cache, options.model);
  const outstanding = units.filter((unit) => unit.missing.length > 0);
  return {
    postings: resolved.length,
    texts: units.length,
    wanted: resolved.length * options.criteria.length,
    // Counted per posting, because that is what a reader sees answered.
    cached: resolved.reduce(
      (total, posting) => total + (held.get(posting.contentHash)?.length ?? 0),
      0,
    ),
    toAsk: outstanding.length,
    nanoUsd: outstanding.reduce(
      (total, unit) => total + estimateNanoUsd(unit.posting, unit.missing),
      0,
    ),
  };
}

/**
 * Answers the criteria about the named postings: cache first, then one request per distinct
 * text for whatever is missing, stopping at the allowance, the deadline, or a run of failures.
 *
 * One request per text with every missing criterion inside it, because the text is the
 * expensive part and is shared (ADR-0025). Texts are never packed together.
 */
export async function askCriteria(options: AskOptions): Promise<AskResult> {
  const now = options.now ?? Date.now;
  const { criteria, cache, client } = options;
  const model = client.model;

  const resolved = await options.postings.read(options.idPrefixes);
  const { units, held } = await planUnits(resolved, criteria, cache, model);

  const queue = units.filter((unit) => unit.missing.length > 0);
  const totals = { asked: 0, failed: 0, cost: 0 };
  const errors: string[] = [];
  const fresh = new Map<string, CriterionAnswer[]>();
  let consecutive = 0;
  let stoppedBy: StoppedBy = "finished";

  /**
   * Records why the run stopped, by precedence rather than by whichever worker finished last.
   *
   * Workers stop independently, so one hitting the budget and another running out of attempts
   * would otherwise report whichever returned last. The budget is the binding constraint when
   * it is reached, and it is the one a reader can act on, so it wins over a deadline, and both
   * win over a run of failures.
   */
  const rank: Readonly<Record<StoppedBy, number>> = {
    finished: 0,
    errors: 1,
    deadline: 2,
    budget: 3,
  };
  const stopBecause = (reason: StoppedBy): void => {
    if (rank[reason] > rank[stoppedBy]) stoppedBy = reason;
  };

  const askOne = async (unit: TextUnit): Promise<void> => {
    const result = await client.ask({
      purpose: "criterion",
      state: {
        posting: {
          title: unit.posting.title,
          company: unit.posting.company,
          locations: [...unit.posting.locations],
          description: unit.posting.description,
        },
      },
      questions: Object.fromEntries(
        unit.missing.map((criterion) => [criterion.id, criterion.question]),
      ),
    });
    totals.cost += result.usage.costNanoUsd;

    const answered: CriterionAnswer[] = [];
    for (const criterion of unit.missing) {
      const answer = (result.answers as Record<string, unknown>)[criterion.id];
      if (answer === undefined) continue;
      const answerJson = JSON.stringify(answer);
      // Written back under this criterion and model, so the next asker pays nothing.
      await cache.write(criterion.id, model, [{ contentHash: unit.contentHash, answerJson }]);
      const distribution = readAnswer(answerJson, kindOf(criterion), criterion.options);
      if (distribution === null) continue;
      answered.push({ criterionId: criterion.id, distribution, cached: false });
    }
    fresh.set(unit.contentHash, answered);
    consecutive = 0;
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (now() >= options.deadline) {
        stopBecause("deadline");
        return;
      }
      if (consecutive >= CONSECUTIVE_FAILURES) {
        stopBecause("errors");
        return;
      }
      const unit = queue.shift();
      if (unit === undefined) return;
      // An early exit, not the cap: see `allowanceNanoUsd`.
      const estimate = estimateNanoUsd(unit.posting, unit.missing);
      if (totals.cost + estimate > options.allowanceNanoUsd) {
        queue.unshift(unit);
        stopBecause("budget");
        return;
      }
      totals.asked += 1;
      try {
        await askOne(unit);
      } catch (caught) {
        // A refused spend is the budget speaking, not this posting. It is neither counted as a
        // failure nor allowed to add to the run of failures, because five postings refused for
        // lack of money are not evidence that anything is broken.
        if (caught instanceof JevError && caught.code === "BUDGET_EXCEEDED") {
          queue.unshift(unit);
          totals.asked -= 1;
          stopBecause("budget");
          return;
        }
        totals.failed += 1;
        consecutive += 1;
        const message =
          caught instanceof JevError
            ? `${caught.code}: ${caught.message}`
            : caught instanceof Error
              ? caught.message
              : String(caught);
        if (errors.length < ERRORS_SHOWN) errors.push(message);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, worker));

  // Every posting gets the answers for its text, so a repost is answered by the one request.
  const answers: PostingAnswers[] = resolved.map((posting) => ({
    id: posting.id,
    answers: [...(held.get(posting.contentHash) ?? []), ...(fresh.get(posting.contentHash) ?? [])],
  }));
  const answeredPairs = answers.reduce((total, posting) => total + posting.answers.length, 0);
  const wanted = resolved.length * criteria.length;
  return {
    answers,
    report: {
      postings: resolved.length,
      texts: units.length,
      wanted,
      cached: resolved.reduce(
        (total, posting) => total + (held.get(posting.contentHash)?.length ?? 0),
        0,
      ),
      asked: totals.asked,
      failed: totals.failed,
      costNanoUsd: totals.cost,
      stoppedBy,
      outstanding: wanted - answeredPairs,
      errors,
    },
  };
}
