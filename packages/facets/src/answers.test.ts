import { test } from "@fast-check/vitest";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type AnswerKind,
  type Distribution,
  likeliest,
  probabilityOf,
  readAnswer,
} from "./answers.ts";

const ARRANGEMENT = ["remote", "hybrid", "onsite", "not_stated"];
const LEVELS = ["0", "1", "2", "3", "4"];
const YES_NO = ["no", "yes"];

function choiceAnswer(probabilities: Record<string, number>, choice = "remote"): string {
  return JSON.stringify({
    type: "choice",
    choice,
    confidence: probabilities[choice],
    probabilities,
  });
}

describe("readAnswer", () => {
  it("reads a choice answer in the registry's option order, not the stored order", () => {
    // The stored object lists onsite first; the distribution must still follow ARRANGEMENT.
    const json = JSON.stringify({
      type: "choice",
      choice: "remote",
      confidence: 0.7,
      probabilities: { onsite: 0.1, not_stated: 0.0, remote: 0.7, hybrid: 0.2 },
    });
    expect(readAnswer(json, "choice", ARRANGEMENT)).toEqual([70, 20, 10, 0]);
  });

  it("expands a yes/no answer into its two options", () => {
    expect(readAnswer(JSON.stringify({ type: "noul", noul: 0.25 }), "noul", YES_NO)).toEqual([
      75, 25,
    ]);
  });

  it("reads a score answer by level", () => {
    const json = JSON.stringify({
      type: "score",
      score: 2.7,
      confidence: 0.5,
      legend: {},
      probabilities: { "0": 0, "1": 0.1, "2": 0.3, "3": 0.5, "4": 0.1 },
    });
    expect(readAnswer(json, "score", LEVELS)).toEqual([0, 10, 30, 50, 10]);
  });

  it("refuses an answer of the wrong kind", () => {
    const json = JSON.stringify({ type: "noul", noul: 0.5 });
    expect(readAnswer(json, "choice", ARRANGEMENT)).toBeNull();
  });

  it("refuses an answer whose options do not match the registry's", () => {
    // "wfh" was renamed to "remote": realigning silently would mean a wrong answer.
    const json = choiceAnswer({ wfh: 0.7, hybrid: 0.2, onsite: 0.1, not_stated: 0 }, "hybrid");
    expect(readAnswer(json, "choice", ARRANGEMENT)).toBeNull();
  });

  it("refuses an answer missing an option", () => {
    const json = choiceAnswer({ remote: 0.8, hybrid: 0.2 });
    expect(readAnswer(json, "choice", ARRANGEMENT)).toBeNull();
  });

  it("refuses an answer with an extra option", () => {
    const json = choiceAnswer({
      remote: 0.5,
      hybrid: 0.2,
      onsite: 0.1,
      not_stated: 0.1,
      flexible: 0.1,
    });
    expect(readAnswer(json, "choice", ARRANGEMENT)).toBeNull();
  });

  it("refuses probabilities that do not sum to one", () => {
    const json = choiceAnswer({ remote: 0.9, hybrid: 0.9, onsite: 0, not_stated: 0 });
    expect(readAnswer(json, "choice", ARRANGEMENT)).toBeNull();
  });

  it("accepts the rounding slack that two published decimals allow", () => {
    // Each of four entries may be off by half a unit in the second decimal.
    const json = choiceAnswer({ remote: 0.33, hybrid: 0.33, onsite: 0.33, not_stated: 0.0 });
    expect(readAnswer(json, "choice", ARRANGEMENT)).toEqual([34, 33, 33, 0]);
  });

  it.each([
    ["not JSON", "{oops"],
    ["a JSON scalar", "7"],
    ["null", "null"],
    ["a missing type", JSON.stringify({ probabilities: { remote: 1 } })],
    ["a probability above one", JSON.stringify({ type: "noul", noul: 1.5 })],
    ["a negative probability", JSON.stringify({ type: "noul", noul: -0.1 })],
    ["a non-numeric probability", JSON.stringify({ type: "noul", noul: "0.5" })],
    ["probabilities that are not an object", JSON.stringify({ type: "choice", probabilities: 1 })],
  ])("refuses %s", (_name, json) => {
    expect(readAnswer(json, "noul", YES_NO) ?? readAnswer(json, "choice", ARRANGEMENT)).toBeNull();
  });

  it("keeps an answer that is certain", () => {
    const json = choiceAnswer({ remote: 1, hybrid: 0, onsite: 0, not_stated: 0 });
    expect(readAnswer(json, "choice", ARRANGEMENT)).toEqual([100, 0, 0, 0]);
  });
});

describe("the distribution invariant", () => {
  const anyProbabilities = (count: number) =>
    fc
      .array(fc.integer({ min: 0, max: 100 }), { minLength: count, maxLength: count })
      .filter((values) => values.reduce((total, value) => total + value, 0) > 0)
      .map((values) => {
        const sum = values.reduce((total, value) => total + value, 0);
        // Two decimals, as Jev publishes them, and summing to 1 within the allowed slack.
        return values.map((value) => Math.round((value / sum) * 100) / 100);
      });

  test.prop([anyProbabilities(4)])("a read distribution sums to exactly 100", (probabilities) => {
    const record = Object.fromEntries(
      ARRANGEMENT.map((option, index) => [option, probabilities[index] ?? 0]),
    );
    const distribution = readAnswer(choiceAnswer(record), "choice", ARRANGEMENT);
    fc.pre(distribution !== null);
    expect(distribution?.reduce((total, value) => total + value, 0)).toBe(100);
  });

  test.prop([fc.integer({ min: 0, max: 100 })])(
    "a yes/no answer and its complement sum to exactly 100",
    (percent) => {
      const distribution = readAnswer(
        JSON.stringify({ type: "noul", noul: percent / 100 }),
        "noul",
        YES_NO,
      );
      expect(distribution).toEqual([100 - percent, percent]);
    },
  );
});

describe("reading a distribution", () => {
  const distribution: Distribution = [70, 20, 10, 0];

  it("names the likeliest option", () => {
    expect(likeliest(distribution)).toBe(0);
    expect(likeliest([5, 60, 35, 0])).toBe(1);
  });

  it("breaks a tie on the lowest option index, so the result is stable", () => {
    expect(likeliest([50, 50, 0, 0])).toBe(0);
  });

  it("adds up the probability of a set of options", () => {
    expect(probabilityOf(distribution, [0])).toBe(70);
    expect(probabilityOf(distribution, [0, 1])).toBe(90);
    expect(probabilityOf(distribution, [])).toBe(0);
  });

  it("gives the complement exactly, with no rounding gap", () => {
    const all = [0, 1, 2, 3];
    const chosen = [1, 2];
    const rest = all.filter((option) => !chosen.includes(option));
    expect(probabilityOf(distribution, chosen) + probabilityOf(distribution, rest)).toBe(100);
  });

  it("ignores an option index that is not in the distribution", () => {
    expect(probabilityOf(distribution, [9])).toBe(0);
  });
});

describe("every kind round trips", () => {
  const cases: readonly [AnswerKind, readonly string[], string][] = [
    ["noul", YES_NO, JSON.stringify({ type: "noul", noul: 0.42 })],
    [
      "choice",
      ARRANGEMENT,
      choiceAnswer({ remote: 0.4, hybrid: 0.3, onsite: 0.2, not_stated: 0.1 }),
    ],
    [
      "score",
      LEVELS,
      JSON.stringify({
        type: "score",
        score: 2,
        confidence: 0.4,
        legend: {},
        probabilities: { "0": 0.1, "1": 0.2, "2": 0.4, "3": 0.2, "4": 0.1 },
      }),
    ],
  ];

  it.each(cases)("%s reads into one probability per option", (kind, options, json) => {
    const distribution = readAnswer(json, kind, options);
    expect(distribution).toHaveLength(options.length);
    expect(distribution?.reduce((total, value) => total + value, 0)).toBe(100);
  });
});
