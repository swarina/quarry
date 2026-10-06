import { canonicalJson, sha256Hex } from "@quarry/domain";
import { assertValidQuestions, choice, JEV_LIMITS, noul, type Question, score } from "@quarry/jev";

/**
 * A criterion is one question a person wrote, in their own words, about a posting.
 *
 * This is the wedge: the standard questions (`@quarry/questions`) are fixed and asked of
 * everything once, while a criterion is whatever someone wants to know, asked of the postings
 * they are looking at. The two differ in who writes the wording, and therefore in what can be
 * trusted about it: a standard question was reviewed and versioned, a criterion arrives as text
 * from outside and has to be checked before any money is spent on it.
 */

/** One option of a pick-one criterion. */
export interface CriterionOption {
  readonly label: string;
  /** What the option means. Jev reads this, so it is worth writing. */
  readonly what?: string;
}

/**
 * What a person wrote. Three shapes, matching the three answers Jev gives:
 *
 * - `yes-no` becomes a `noul` question, answered with the probability of yes;
 * - `choice` becomes a `choice` question over the options they named;
 * - `scale` becomes a `score` question over the levels they described, lowest first.
 */
export type CriterionInput =
  | { readonly kind: "yes-no"; readonly question: string }
  | {
      readonly kind: "choice";
      readonly question: string;
      readonly options: readonly CriterionOption[];
    }
  | { readonly kind: "scale"; readonly question: string; readonly levels: readonly string[] };

/** A criterion that passed validation: normalized, with the Jev question it becomes. */
export interface Criterion {
  /**
   * Content hash of the normalized criterion. The cache key, and stable across requests, so two
   * people asking the same thing in the same words share an answer.
   *
   * A wording is the question (ADR-0024), so the id covers the wording and the options, not just
   * the kind. Changing a word makes a different criterion, which is correct: Jev reads it
   * literally, so the old answers are answers to something else.
   */
  readonly id: string;
  readonly input: CriterionInput;
  /** The option ids an answer distributes over, in order, as `@quarry/facets` reads them. */
  readonly options: readonly string[];
  /** What each option means, same order, for showing a result. */
  readonly labels: readonly string[];
  readonly kind: CriterionInput["kind"];
  readonly question: Question;
}

export class CriterionError extends Error {
  override readonly name = "CriterionError";
}

function invalid(what: string): never {
  throw new CriterionError(what);
}

/**
 * Longest question accepted. This is Quarry's own limit, not one TypeSafe documents: the SDK
 * states no bound on instruction length. It exists because the question is sent with every
 * posting, so its length is multiplied by the number of postings asked about, and because a
 * question that does not fit in a sentence or two is usually several questions.
 */
export const MAX_QUESTION_LENGTH = 500;

/** Longest option label and description, for the same reason. */
export const MAX_LABEL_LENGTH = 120;

function text(value: unknown, what: string, limit: number): string {
  if (typeof value !== "string") invalid(`${what} is not text`);
  const trimmed = value.trim();
  if (trimmed === "") invalid(`${what} is empty`);
  if (trimmed.length > limit) invalid(`${what} is longer than ${limit} characters`);
  return trimmed;
}

/** The yes and no options a `noul` answer is read as, matching `NOUL_OPTIONS` in the registry. */
const YES_NO: readonly string[] = ["no", "yes"];

/**
 * Checks and normalizes what a person wrote, and builds the Jev question it becomes.
 *
 * Everything is checked before a request is built, because the alternative is paying for a
 * question the model could not answer. The limits on option and level counts are Jev's own
 * (`JEV_LIMITS`), so a criterion that passes here is one the API will accept.
 */
export async function readCriterion(input: unknown): Promise<Criterion> {
  if (input === null || typeof input !== "object") invalid("criterion is not an object");
  const given = input as Record<string, unknown>;
  const kind = given["kind"];
  const question = text(given["question"], "question", MAX_QUESTION_LENGTH);

  let normalized: CriterionInput;
  let options: string[];
  let labels: string[];
  let built: Question;

  if (kind === "yes-no") {
    normalized = { kind, question };
    options = [...YES_NO];
    labels = ["No", "Yes"];
    built = noul(question);
  } else if (kind === "choice") {
    const given_options = given["options"];
    if (!Array.isArray(given_options)) invalid("options is not a list");
    if (given_options.length < 2) invalid("a pick-one criterion needs at least 2 options");
    if (given_options.length > JEV_LIMITS.maxChoiceOptions) {
      invalid(`a pick-one criterion allows at most ${JEV_LIMITS.maxChoiceOptions} options`);
    }
    const read = given_options.map((option, at) => {
      if (option === null || typeof option !== "object") invalid(`options[${at}] is not an object`);
      const entry = option as Record<string, unknown>;
      const label = text(entry["label"], `options[${at}].label`, MAX_LABEL_LENGTH);
      const what =
        entry["what"] === undefined
          ? undefined
          : text(entry["what"], `options[${at}].what`, MAX_LABEL_LENGTH);
      return { label, ...(what === undefined ? {} : { what }) };
    });
    // Two options with the same label would collide in the answer, which is keyed by label.
    if (new Set(read.map((option) => option.label)).size !== read.length) {
      invalid("two options have the same label");
    }
    normalized = { kind, question, options: read };
    options = read.map((option) => option.label);
    labels = read.map((option) => option.what ?? option.label);
    built = choice(
      question,
      // A null description is allowed and means "undescribed", which is what no `what` is.
      Object.fromEntries(read.map((option) => [option.label, option.what ?? null])),
    );
  } else if (kind === "scale") {
    const given_levels = given["levels"];
    if (!Array.isArray(given_levels)) invalid("levels is not a list");
    if (given_levels.length < JEV_LIMITS.minScoreLevels) {
      invalid(`a scale criterion needs at least ${JEV_LIMITS.minScoreLevels} levels`);
    }
    if (given_levels.length > JEV_LIMITS.maxScoreLevels) {
      invalid(`a scale criterion allows at most ${JEV_LIMITS.maxScoreLevels} levels`);
    }
    const read = given_levels.map((level, at) => text(level, `levels[${at}]`, MAX_LABEL_LENGTH));
    normalized = { kind, question, levels: read };
    // Score answers are keyed by level index, lowest first, as the registry reads them.
    options = read.map((_level, at) => String(at));
    labels = read;
    // A rubric is a tuple of at least two, which the length check above has established. Taking
    // the first two out builds that tuple for the type system rather than asserting it.
    const [lowest, next, ...above] = read;
    if (lowest === undefined || next === undefined) invalid("a scale criterion needs 2 levels");
    built = score(question, [lowest, next, ...above]);
  } else {
    invalid(`kind is not one of yes-no, choice, or scale: ${String(kind)}`);
  }

  // The same validator the client applies before spending, so this cannot drift from the rules
  // the request will actually be held to: a criterion that passes here is one Jev will accept.
  try {
    assertValidQuestions({ criterion: built });
  } catch (caught) {
    invalid(caught instanceof Error ? caught.message : String(caught));
  }

  return {
    id: await sha256Hex(canonicalJson(normalized as unknown as Record<string, unknown>)),
    input: normalized,
    options,
    labels,
    kind: normalized.kind,
    question: built,
  };
}

/** Reads a list of criteria, refusing duplicates, which would be paid for twice. */
export async function readCriteria(input: unknown, most: number): Promise<readonly Criterion[]> {
  if (!Array.isArray(input)) invalid("criteria is not a list");
  if (input.length === 0) invalid("no criteria given");
  if (input.length > most) invalid(`at most ${most} criteria at a time`);
  const read = await Promise.all(input.map((entry) => readCriterion(entry)));
  if (new Set(read.map((criterion) => criterion.id)).size !== read.length) {
    invalid("the same criterion was given twice");
  }
  return read;
}
