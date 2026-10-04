/**
 * Answers to the standard questions, read from what the model gave into the one shape the
 * search index stores: a probability per option, in hundredths.
 *
 * Nothing here trusts the stored JSON. A row is whatever some model returned at some point,
 * possibly under a wording that has since changed, so anything that does not read cleanly
 * becomes "no answer" rather than a confident wrong one. The caller decides what to do with a
 * `null`, and the pipeline reports how many it got.
 *
 * This module is deliberately free of dependencies: the index build reads answers with it, and
 * it must not drag the gazetteer (or the SDK) along behind it.
 */

/**
 * Version of the reading below. Bump it when the same stored answer can produce a different
 * distribution, so artifacts built from answers say which rules made them.
 */
export const ANSWER_FACETS_VERSION = 1;

/** The three answer kinds Jev returns. Mirrors `AnswerKind` in `@quarry/questions`. */
export type AnswerKind = "choice" | "score" | "noul";

/**
 * Probabilities in hundredths, one per option, summing to exactly 100.
 *
 * Hundredths lose nothing: Jev publishes probabilities to two decimals, which the response
 * schema in `@quarry/jev` relies on as well. Summing to exactly 100 is this module's own
 * guarantee, so that the probability of "not these options" is exactly 100 minus theirs and the
 * site never has to show a total of 99.
 */
export type Distribution = readonly number[];

/**
 * How far a distribution may miss 1 before it is malformed. Published with two decimals, each
 * entry can be off by half a unit in the second decimal. The same rule lives in
 * `@quarry/jev`'s response schema, which checks the answer on its way in; this checks it on the
 * way out, months later, from a store written by an older version of that code.
 */
function tolerance(entries: number[]): number {
  return Math.max(0.01, entries.length * 0.005) + 1e-9;
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * Scales probabilities to hundredths that sum to exactly 100, giving the spare units to the
 * largest fractions first (and the lowest option index to break a tie, so the result is
 * deterministic). The values are normalized by their own sum first, so the spare units are
 * never negative however far off 1 the input was.
 */
function toHundredths(values: readonly number[]): number[] {
  const sum = values.reduce((total, value) => total + value, 0);
  const scaled = values.map((value) => (value / sum) * 100);
  const result = scaled.map((value) => Math.floor(value));
  let spare = 100 - result.reduce((total, value) => total + value, 0);
  const byFraction = scaled
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index);
  for (const { index } of byFraction) {
    if (spare <= 0) break;
    result[index] = (result[index] ?? 0) + 1;
    spare -= 1;
  }
  return result;
}

/** Reads the `probabilities` record of a choice or score answer, in the given option order. */
function readProbabilities(source: unknown, options: readonly string[]): number[] | null {
  if (source === null || typeof source !== "object") return null;
  const record = source as Record<string, unknown>;
  // Every option must be present: a missing one would otherwise read as an impossible answer.
  if (Object.keys(record).length !== options.length) return null;
  const values: number[] = [];
  for (const option of options) {
    const value = record[option];
    if (!isProbability(value)) return null;
    values.push(value);
  }
  return values;
}

/**
 * Reads one stored answer into a distribution over `options`, or `null` when the stored JSON
 * does not answer this question in this shape.
 *
 * `options` comes from the question registry (`answerShape`), so a stored answer whose options
 * no longer match the registry's is refused rather than silently realigned.
 */
export function readAnswer(
  answerJson: string,
  kind: AnswerKind,
  options: readonly string[],
): Distribution | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(answerJson);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const answer = parsed as Record<string, unknown>;
  if (answer["type"] !== kind) return null;

  if (kind === "noul") {
    // A yes/no answer is one probability, expanded into the two options it implies.
    if (options.length !== 2) return null;
    const yes = answer["noul"];
    if (!isProbability(yes)) return null;
    return toHundredths([1 - yes, yes]);
  }

  const values = readProbabilities(answer["probabilities"], options);
  if (values === null) return null;
  const sum = values.reduce((total, value) => total + value, 0);
  if (Math.abs(sum - 1) > tolerance(values)) return null;
  return toHundredths(values);
}

/** The option the answer picked: the most probable one, lowest index breaking a tie. */
export function likeliest(distribution: Distribution): number {
  let best = 0;
  for (let index = 1; index < distribution.length; index += 1) {
    if ((distribution[index] ?? 0) > (distribution[best] ?? 0)) best = index;
  }
  return best;
}

/** The probability, in hundredths, that the answer is one of `options` (given as indices). */
export function probabilityOf(distribution: Distribution, options: Iterable<number>): number {
  let total = 0;
  for (const option of options) total += distribution[option] ?? 0;
  return total;
}
