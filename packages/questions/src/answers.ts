import type { Question } from "@quarry/jev";

/**
 * How each standard question's answer is shaped, so code that stores or reads answers does not
 * have to know the registry's internals. The search index carries this description inside every
 * shard, which is what lets the browser read answers without loading the registry (and with it
 * the SDK).
 */

/** The three answer kinds Jev returns, named as the SDK names them. */
export type AnswerKind = "choice" | "score" | "noul";

export interface AnswerShape {
  readonly id: string;
  /** The wording version that produced an answer of this shape. */
  readonly version: number;
  readonly about: string;
  readonly kind: AnswerKind;
  /**
   * Stable option ids, in the order probabilities are stored in. Choice options keep their
   * labels, score levels are their indices as strings, and a yes/no answer is described as two
   * options so that every filter can be the same thing: the probability that the answer is one
   * of a chosen set.
   */
  readonly options: readonly string[];
  /** What each option means, in the same order, for the site to show. */
  readonly labels: readonly string[];
}

/** The yes/no options, in the order a `noul` probability is expanded into. */
export const NOUL_OPTIONS = ["no", "yes"] as const;

function describe(description: unknown): string {
  // A criterion may be text, a JSON object, or null; only the `what` of an object is shown.
  if (typeof description === "string") return description;
  if (description !== null && typeof description === "object") {
    const what = (description as { what?: unknown }).what;
    if (typeof what === "string") return what;
  }
  return "";
}

/** The options and their descriptions for one question, in the order answers are stored in. */
export function answerShape(question: Question): Pick<AnswerShape, "kind" | "options" | "labels"> {
  switch (question.type) {
    case "noul":
      return {
        kind: "noul",
        options: [...NOUL_OPTIONS],
        labels: ["No", "Yes"],
      };
    case "choice": {
      const options = Object.keys(question.criteria);
      return {
        kind: "choice",
        options,
        labels: options.map((option) => describe(question.criteria[option])),
      };
    }
    case "score":
      return {
        kind: "score",
        options: question.criteria.map((_, level) => String(level)),
        labels: question.criteria.map((criterion) => describe(criterion)),
      };
  }
}
