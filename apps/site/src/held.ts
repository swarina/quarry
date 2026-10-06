/**
 * The answers a criterion has produced in this session, held in memory.
 *
 * They are not in the index and never will be: the index is a build artifact shared by everyone,
 * and a criterion is one person's question about one page of results. They are not in the URL
 * either, because a distribution per posting is far too large for one and the server already
 * caches them under the wording (ADR-0024), so re-asking the same question of the same postings
 * costs nothing.
 *
 * What that means for a reader: a reload loses the answers and keeps the question, and asking it
 * again is free. That is the honest trade and it is worth stating on screen, which `render.ts`
 * does.
 */
import { likeliest, probabilityOf } from "@quarry/facets";
import type { AskReply, CriterionDescription } from "./criteria.ts";

export interface Held {
  /** The criterion these answers belong to, so answers to an older wording are never shown. */
  readonly criterionId: string;
  /** How the server described it, which is what labels an answer. */
  readonly description: CriterionDescription;
  /** Posting id to the probability of each option, in hundredths, in the criterion's order. */
  readonly byPosting: ReadonlyMap<string, readonly number[]>;
}

/**
 * Reads a reply into what the page holds, keeping whatever came back.
 *
 * A run that stopped early still answered some postings, and those answers are as good as any
 * other: the stop reason governs what is said about the ones that are missing, not whether the
 * ones that arrived can be trusted.
 */
export function keep(reply: AskReply): Held | undefined {
  const description = reply.criteria[0];
  if (description === undefined) return undefined;
  const byPosting = new Map<string, readonly number[]>();
  for (const posting of reply.answers) {
    const answer = posting.answers.find((entry) => entry.criterionId === description.id);
    // A distribution of the wrong width cannot be joined to the options, so it is not kept: the
    // alternative is labelling a probability with whatever option happens to sit at that index.
    if (answer === undefined || answer.distribution.length !== description.options.length) continue;
    byPosting.set(posting.id, answer.distribution);
  }
  return { criterionId: description.id, description, byPosting };
}

/** Merges newly arrived answers into what is already held for the same criterion. */
export function merge(held: Held | undefined, arrived: Held): Held {
  if (held === undefined || held.criterionId !== arrived.criterionId) return arrived;
  const byPosting = new Map(held.byPosting);
  for (const [id, distribution] of arrived.byPosting) byPosting.set(id, distribution);
  return { ...arrived, byPosting };
}

/**
 * Whether a posting's answer satisfies a filter: the probability that it is one of these options
 * is at least this much.
 *
 * A posting with no answer never passes, at any threshold. Not asked and answered "certainly not"
 * are different facts, and the index takes the same position on the standard questions.
 */
export function passes(
  held: Held,
  postingId: string,
  filter: { readonly options: readonly string[]; readonly atLeast: number },
): boolean {
  const distribution = held.byPosting.get(postingId);
  if (distribution === undefined) return false;
  const indices = filter.options
    .map((option) => held.description.options.indexOf(option))
    .filter((at) => at >= 0);
  if (indices.length === 0) return false;
  return probabilityOf(distribution, indices) >= filter.atLeast;
}

/** What the model said about one posting: its likeliest option and how probable that is. */
export function readingOf(
  held: Held,
  postingId: string,
): { readonly label: string; readonly probability: number } | undefined {
  const distribution = held.byPosting.get(postingId);
  if (distribution === undefined) return undefined;
  const at = likeliest(distribution);
  const label = held.description.labels[at] ?? held.description.options[at];
  if (label === undefined) return undefined;
  return { label, probability: distribution[at] ?? 0 };
}

/** How many of the postings on screen have been answered, for saying so plainly. */
export function answeredAmong(held: Held, ids: readonly string[]): number {
  let count = 0;
  for (const id of ids) if (held.byPosting.has(id)) count += 1;
  return count;
}
