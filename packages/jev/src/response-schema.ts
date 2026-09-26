import type { Question, Questions } from "@typesafe-ai/sdk";
import { z } from "zod";

const probability = z.number().min(0).max(1);

/** Tolerance for an expected score that lands a hair past the top level through rounding. */
const SCORE_EPSILON = 1e-6;

/**
 * Probabilities are published with limited precision, so a distribution may miss 1 by up to
 * half a unit in the second decimal per entry. Anything further off is a malformed response.
 */
function sumsToOne(distribution: Record<string, number>): boolean {
  const values = Object.values(distribution);
  const sum = values.reduce((total, value) => total + value, 0);
  const tolerance = Math.max(0.01, values.length * 0.005) + 1e-9;
  return Math.abs(sum - 1) <= tolerance;
}

const distributionMessage = { message: "Probabilities must sum to 1" };

/**
 * Answer objects are loose: fields we do not check (such as a Score's `legend`) pass through
 * unchanged, so validated values keep the shape the SDK's types promise.
 */
function answerSchema(question: Question): z.ZodType {
  switch (question.type) {
    case "noul":
      return z.looseObject({ type: z.literal("noul"), noul: probability });
    case "choice": {
      const label = z.enum(Object.keys(question.criteria));
      return z.looseObject({
        type: z.literal("choice"),
        choice: label,
        confidence: probability,
        probabilities: z.record(label, probability).refine(sumsToOne, distributionMessage),
      });
    }
    case "score": {
      const levels = question.criteria.length;
      const level = z.enum(Array.from({ length: levels }, (_, index) => String(index)));
      return z.looseObject({
        type: z.literal("score"),
        score: z
          .number()
          .min(0)
          .max(levels - 1 + SCORE_EPSILON),
        confidence: probability,
        probabilities: z.record(level, probability).refine(sumsToOne, distributionMessage),
      });
    }
  }
}

/** Schema for a `POST /v1/systemone` response to exactly this question set. */
export function responseSchema(questions: Questions) {
  const answers: Record<string, z.ZodType> = {};
  for (const [id, question] of Object.entries(questions)) answers[id] = answerSchema(question);

  return z.object({
    model: z.string().min(1),
    answers: z.strictObject(answers),
    usage: z.object({
      input_tokens: z.int().nonnegative(),
      output_tokens: z.int().nonnegative(),
    }),
  });
}
