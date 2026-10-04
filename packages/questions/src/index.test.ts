import { assertValidQuestions } from "@quarry/jev";
import { describe, expect, it } from "vitest";
import { postingState, questionsVersion, STANDARD_QUESTIONS, standardQuestions } from "./index.ts";

describe("the standard questions", () => {
  it("are valid questions the model will accept", () => {
    expect(() => assertValidQuestions(standardQuestions())).not.toThrow();
    expect(Object.keys(standardQuestions())).toHaveLength(STANDARD_QUESTIONS.length);
  });

  it("have ids that are unique and versions that start at one", () => {
    const ids = STANDARD_QUESTIONS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of STANDARD_QUESTIONS) {
      expect(entry.version).toBeGreaterThanOrEqual(1);
      expect(entry.about).not.toBe("");
    }
  });

  it("name every wording asked for, so answers to an older one are found again", () => {
    expect(questionsVersion().split(",")).toEqual(
      STANDARD_QUESTIONS.map((entry) => `${entry.id}@${entry.version}`),
    );
    // A reworded question is a different question: its answers must not be reused.
    expect(questionsVersion()).toContain("arrangement@1");
  });

  it("show the model the posting's own words, and nothing else about it", () => {
    const state = postingState({
      title: "Engineer",
      company: "Acme",
      locations: ["Berlin"],
      description: "Build things.",
    });
    expect(state).toEqual({
      posting: {
        title: "Engineer",
        company: "Acme",
        locations: ["Berlin"],
        description: "Build things.",
      },
    });
  });
});
