import type { Questions } from "@typesafe-ai/sdk";
import { JevError } from "./errors.ts";
import { JEV_LIMITS } from "./model.ts";

export type {
  ChoiceQuestion,
  EntryType,
  Fetch,
  NoulQuestion,
  Question,
  Questions,
  ResultFor,
  ScoreQuestion,
  SystemOneResult,
} from "@typesafe-ai/sdk";
export { choice, noul, score } from "@typesafe-ai/sdk";

/**
 * Rejects question sets the API would refuse or answer meaninglessly, before any money is spent.
 * Question ids are never sent to the model, so every question must carry its own instructions.
 */
export function assertValidQuestions(questions: Questions): void {
  const entries = Object.entries(questions);
  if (entries.length === 0) invalid("At least one question is required");

  for (const [id, question] of entries) {
    if (isBlank(question.instructions)) invalid(`Question "${id}" has no instructions`);

    if (question.type === "choice") {
      const options = Object.keys(question.criteria).length;
      if (options < 2 || options > JEV_LIMITS.maxChoiceOptions) {
        invalid(
          `Choice "${id}" has ${options} options; it needs 2 to ${JEV_LIMITS.maxChoiceOptions}`,
        );
      }
    } else if (question.type === "score") {
      const levels = question.criteria.length;
      if (levels < JEV_LIMITS.minScoreLevels || levels > JEV_LIMITS.maxScoreLevels) {
        invalid(
          `Score "${id}" has ${levels} levels; it needs ${JEV_LIMITS.minScoreLevels} to ${JEV_LIMITS.maxScoreLevels}`,
        );
      }
    }
  }
}

function isBlank(instructions: unknown): boolean {
  return (
    instructions === undefined ||
    instructions === null ||
    (typeof instructions === "string" && instructions.trim() === "")
  );
}

function invalid(message: string): never {
  throw new JevError("INVALID_QUESTIONS", message);
}
