import { describe, expect, it } from "vitest";
import {
  CriterionError,
  type CriterionInput,
  MAX_LABEL_LENGTH,
  MAX_QUESTION_LENGTH,
  readCriteria,
  readCriterion,
} from "./criterion.ts";

const YES_NO: CriterionInput = {
  kind: "yes-no",
  question: "Does this team own its infrastructure end to end?",
};

describe("reading a yes/no criterion", () => {
  it("becomes a noul question with two options", async () => {
    const criterion = await readCriterion(YES_NO);
    expect(criterion.kind).toBe("yes-no");
    expect(criterion.options).toEqual(["no", "yes"]);
    expect(criterion.labels).toEqual(["No", "Yes"]);
    expect(criterion.question.type).toBe("noul");
    expect(criterion.question.instructions).toBe(YES_NO.question);
  });
});

describe("reading a pick-one criterion", () => {
  const input: CriterionInput = {
    kind: "choice",
    question: "Is this a real ML role or data engineering with an ML title?",
    options: [
      { label: "ml", what: "Trains or evaluates models" },
      { label: "data", what: "Builds pipelines that feed models" },
      { label: "unclear" },
    ],
  };

  it("keeps the options in order, and their descriptions", async () => {
    const criterion = await readCriterion(input);
    expect(criterion.options).toEqual(["ml", "data", "unclear"]);
    expect(criterion.labels).toEqual([
      "Trains or evaluates models",
      "Builds pipelines that feed models",
      // An option with nothing written about it reads as its own label.
      "unclear",
    ]);
    expect(criterion.question.type).toBe("choice");
  });

  it("leaves an undescribed option undescribed rather than inventing text", async () => {
    const criterion = await readCriterion(input);
    const criteria = (criterion.question as { criteria: Record<string, unknown> }).criteria;
    expect(criteria["unclear"]).toBeNull();
    expect(criteria["ml"]).toBe("Trains or evaluates models");
  });

  it("refuses two options with the same label, which would collide in the answer", async () => {
    await expect(
      readCriterion({ ...input, options: [{ label: "ml" }, { label: " ml " }] }),
    ).rejects.toThrow(/same label/);
  });

  it("refuses fewer than two options, since there is nothing to tell apart", async () => {
    await expect(readCriterion({ ...input, options: [{ label: "ml" }] })).rejects.toThrow(
      /at least 2 options/,
    );
  });

  it("refuses more options than Jev accepts", async () => {
    const many = Array.from({ length: 256 }, (_value, at) => ({ label: `o${at}` }));
    await expect(readCriterion({ ...input, options: many })).rejects.toThrow(/at most 255/);
  });

  it("accepts a label that names an Object prototype member", async () => {
    // "constructor" as a label once put a function where a value belonged (ADR-0009). It is a
    // legal label, so it is accepted here, and the facets layer is what refuses the answer if a
    // prototype member ever comes back instead of a probability.
    const criterion = await readCriterion({
      ...input,
      options: [{ label: "constructor" }, { label: "toString" }],
    });
    expect(criterion.options).toEqual(["constructor", "toString"]);
  });
});

describe("reading a scale criterion", () => {
  const input: CriterionInput = {
    kind: "scale",
    question: "How heavy is on-call likely to be?",
    levels: ["No on-call", "Rare", "A weekly rota", "Frequent paging"],
  };

  it("numbers the levels from zero, lowest first", async () => {
    const criterion = await readCriterion(input);
    expect(criterion.options).toEqual(["0", "1", "2", "3"]);
    expect(criterion.labels).toEqual(input.kind === "scale" ? input.levels : []);
    expect(criterion.question.type).toBe("score");
  });

  it("refuses fewer levels than Jev accepts", async () => {
    await expect(readCriterion({ ...input, levels: ["only one"] })).rejects.toThrow(
      /at least 2 levels/,
    );
  });

  it("refuses more levels than Jev accepts", async () => {
    const many = Array.from({ length: 11 }, (_value, at) => `level ${at}`);
    await expect(readCriterion({ ...input, levels: many })).rejects.toThrow(/at most 10 levels/);
  });
});

describe("what is refused before anything is spent", () => {
  it.each([
    ["not an object", 7, /not an object/],
    ["no kind", { question: "why?" }, /kind is not one of/],
    ["an unknown kind", { kind: "freeform", question: "why?" }, /kind is not one of/],
    ["no question", { kind: "yes-no" }, /question is not text/],
    ["an empty question", { kind: "yes-no", question: "   " }, /question is empty/],
    ["a question that is not text", { kind: "yes-no", question: 7 }, /question is not text/],
    ["options that are not a list", { kind: "choice", question: "q", options: {} }, /not a list/],
    ["levels that are not a list", { kind: "scale", question: "q", levels: "a,b" }, /not a list/],
    [
      "an option that is not an object",
      { kind: "choice", question: "q", options: ["a", "b"] },
      /options\[0\] is not an object/,
    ],
    [
      "an option with no label",
      { kind: "choice", question: "q", options: [{ what: "a" }, { label: "b" }] },
      /options\[0\]\.label is not text/,
    ],
  ])("refuses %s", async (_name, input, message) => {
    await expect(readCriterion(input)).rejects.toThrow(CriterionError);
    await expect(readCriterion(input)).rejects.toThrow(message);
  });

  it("refuses a question longer than the limit, which every posting would pay for", async () => {
    const long = "a".repeat(MAX_QUESTION_LENGTH + 1);
    await expect(readCriterion({ kind: "yes-no", question: long })).rejects.toThrow(
      /longer than 500/,
    );
  });

  it("accepts a question exactly at the limit", async () => {
    const exact = "a".repeat(MAX_QUESTION_LENGTH);
    await expect(readCriterion({ kind: "yes-no", question: exact })).resolves.toBeDefined();
  });

  it("refuses an option label longer than the limit", async () => {
    const long = "a".repeat(MAX_LABEL_LENGTH + 1);
    await expect(
      readCriterion({ kind: "choice", question: "q", options: [{ label: long }, { label: "b" }] }),
    ).rejects.toThrow(/longer than 120/);
  });
});

describe("the criterion id", () => {
  it("is the same for the same question asked twice, so an answer is shared", async () => {
    const first = await readCriterion(YES_NO);
    const again = await readCriterion({ ...YES_NO });
    expect(again.id).toBe(first.id);
  });

  it("ignores surrounding whitespace, which is not part of the question", async () => {
    const padded = await readCriterion({ ...YES_NO, question: `  ${YES_NO.question}  ` });
    expect(padded.id).toBe((await readCriterion(YES_NO)).id);
  });

  it("changes when a single word changes, because a wording is the question", async () => {
    const reworded = await readCriterion({
      kind: "yes-no",
      question: "Does this team own its infrastructure end to end, mostly?",
    });
    expect(reworded.id).not.toBe((await readCriterion(YES_NO)).id);
  });

  it("changes when an option's description changes, not only its label", async () => {
    const base = { kind: "choice" as const, question: "q" };
    const first = await readCriterion({
      ...base,
      options: [{ label: "a", what: "one" }, { label: "b" }],
    });
    const second = await readCriterion({
      ...base,
      options: [{ label: "a", what: "another" }, { label: "b" }],
    });
    expect(second.id).not.toBe(first.id);
  });

  it("differs between kinds that read the same", async () => {
    const asYesNo = await readCriterion({ kind: "yes-no", question: "Is it remote?" });
    const asChoice = await readCriterion({
      kind: "choice",
      question: "Is it remote?",
      options: [{ label: "no" }, { label: "yes" }],
    });
    expect(asChoice.id).not.toBe(asYesNo.id);
  });

  it("does not depend on the order options were written in", async () => {
    // Two different orders are two different questions: the answer is keyed by label, but the
    // order is what a reader sees, so it is part of the criterion.
    const forward = await readCriterion({
      kind: "choice",
      question: "q",
      options: [{ label: "a" }, { label: "b" }],
    });
    const backward = await readCriterion({
      kind: "choice",
      question: "q",
      options: [{ label: "b" }, { label: "a" }],
    });
    expect(backward.id).not.toBe(forward.id);
  });
});

describe("reading several criteria", () => {
  it("reads them in order", async () => {
    const read = await readCriteria(
      [YES_NO, { kind: "yes-no", question: "Do they sponsor visas?" }],
      5,
    );
    expect(read).toHaveLength(2);
    expect(read[0]?.id).not.toBe(read[1]?.id);
  });

  it("refuses the same criterion twice, which would be paid for twice", async () => {
    await expect(readCriteria([YES_NO, { ...YES_NO }], 5)).rejects.toThrow(/given twice/);
  });

  it("refuses more than the caller allows", async () => {
    const many = Array.from({ length: 6 }, (_value, at) => ({
      kind: "yes-no" as const,
      question: `question ${at}?`,
    }));
    await expect(readCriteria(many, 5)).rejects.toThrow(/at most 5 criteria/);
  });

  it("refuses an empty list rather than running a request that asks nothing", async () => {
    await expect(readCriteria([], 5)).rejects.toThrow(/no criteria/);
  });

  it("refuses something that is not a list", async () => {
    await expect(readCriteria("remote?", 5)).rejects.toThrow(/not a list/);
  });
});
