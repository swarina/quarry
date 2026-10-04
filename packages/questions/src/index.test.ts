import { assertValidQuestions } from "@quarry/jev";
import { describe, expect, it } from "vitest";
import {
  answerShapes,
  postingState,
  questionsVersion,
  STANDARD_QUESTIONS,
  standardQuestions,
} from "./index.ts";

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

describe("answer shapes", () => {
  it("describe every question, in registry order", () => {
    const shapes = answerShapes();
    expect(shapes.map((shape) => shape.id)).toEqual(STANDARD_QUESTIONS.map((entry) => entry.id));
    for (const shape of shapes) {
      // Two options at least, or there is nothing to tell apart.
      expect(shape.options.length).toBeGreaterThanOrEqual(2);
      expect(shape.labels).toHaveLength(shape.options.length);
      expect(new Set(shape.options).size).toBe(shape.options.length);
    }
  });

  it("keep a choice question's own labels, in the order it declares them", () => {
    const arrangement = answerShapes().find((shape) => shape.id === "arrangement");
    expect(arrangement?.kind).toBe("choice");
    expect(arrangement?.options).toEqual(["remote", "hybrid", "onsite", "not_stated"]);
    expect(arrangement?.labels[0]).toContain("fully remotely");
  });

  it("number a score question's levels from zero and describe each one", () => {
    const seniority = answerShapes().find((shape) => shape.id === "seniority");
    expect(seniority?.kind).toBe("score");
    expect(seniority?.options).toEqual(["0", "1", "2", "3", "4"]);
    expect(seniority?.labels[0]).toContain("Internship");
    expect(seniority?.labels.every((label) => label !== "")).toBe(true);
  });

  it("describe a yes/no question as two options, so every filter is one shape", () => {
    const onCall = answerShapes().find((shape) => shape.id === "onCall");
    expect(onCall?.kind).toBe("noul");
    expect(onCall?.options).toEqual(["no", "yes"]);
    expect(onCall?.labels).toEqual(["No", "Yes"]);
  });

  it("carry the wording version, so a shard says which wording its answers came from", () => {
    for (const shape of answerShapes()) {
      const entry = STANDARD_QUESTIONS.find((question) => question.id === shape.id);
      expect(shape.version).toBe(entry?.version);
      expect(shape.about).toBe(entry?.about);
    }
  });
});
