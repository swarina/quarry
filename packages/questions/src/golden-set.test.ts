import { describe, expect, it } from "vitest";
import { goldenSetStatus, MINIMUM_LABELS, parseCsv } from "./golden-set.ts";

const QUESTIONS = [
  { id: "arrangement", options: ["remote", "onsite"] },
  { id: "onCall", options: ["no", "yes"] },
];

/** A sheet of `rows` postings, the first `filled` of them labelled for `question`. */
function sheet(rows: number, filled: Readonly<Record<string, number>>): string {
  const header = ["id", "company", ...QUESTIONS.map((question) => question.id)];
  const lines = [header.join(",")];
  for (let row = 0; row < rows; row += 1) {
    lines.push(
      [
        `p${row}`,
        "Acme",
        ...QUESTIONS.map((question) =>
          row < (filled[question.id] ?? 0) ? (question.options[0] ?? "") : "",
        ),
      ].join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

describe("parseCsv", () => {
  it("reads quoted fields holding commas, quotes, and line breaks", () => {
    expect(parseCsv('"a,b","say ""hi""","two\nlines"\n')).toEqual([
      ["a,b", 'say "hi"', "two\nlines"],
    ]);
  });

  it("reads a final row with no trailing newline", () => {
    expect(parseCsv("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("treats a carriage return pair as one break", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("goldenSetStatus", () => {
  it("is neither partial nor complete when no file is there", () => {
    const status = goldenSetStatus({ questions: QUESTIONS, sheet: null, hasPredictions: false });
    expect(status.hasSheet).toBe(false);
    expect(status.hasPredictions).toBe(false);
    expect(status.partial).toBe(false);
    expect(status.complete).toBe(false);
    expect(status.reason).toContain("the labelling sheet and the predictions file are not there");
  });

  it("names the one file that is missing", () => {
    const status = goldenSetStatus({
      questions: QUESTIONS,
      sheet: sheet(1, {}),
      hasPredictions: false,
    });
    expect(status.reason).toContain("the predictions file is not there");
  });

  it("counts an unlabelled sheet as nothing to score", () => {
    const status = goldenSetStatus({
      questions: QUESTIONS,
      sheet: sheet(150, {}),
      hasPredictions: true,
    });
    expect(status.labelled).toEqual({ arrangement: 0, onCall: 0 });
    expect(status.partial).toBe(false);
    expect(status.complete).toBe(false);
    expect(status.labels).toHaveLength(300);
    expect(status.reason).toContain(`0 of 2 questions have ${MINIMUM_LABELS} or more labels`);
  });

  it("is partial but not complete when one question is labelled", () => {
    const status = goldenSetStatus({
      questions: QUESTIONS,
      sheet: sheet(150, { arrangement: MINIMUM_LABELS }),
      hasPredictions: true,
    });
    expect(status.labelled).toEqual({ arrangement: MINIMUM_LABELS, onCall: 0 });
    expect(status.partial).toBe(true);
    expect(status.complete).toBe(false);
  });

  it("is not partial one label short of the minimum", () => {
    const status = goldenSetStatus({
      questions: QUESTIONS,
      sheet: sheet(150, { arrangement: MINIMUM_LABELS - 1 }),
      hasPredictions: true,
    });
    expect(status.partial).toBe(false);
  });

  it("is complete only once every question has enough", () => {
    const status = goldenSetStatus({
      questions: QUESTIONS,
      sheet: sheet(150, { arrangement: MINIMUM_LABELS, onCall: MINIMUM_LABELS }),
      hasPredictions: true,
    });
    expect(status.partial).toBe(true);
    expect(status.complete).toBe(true);
  });

  it("needs predictions as well as labels", () => {
    const status = goldenSetStatus({
      questions: QUESTIONS,
      sheet: sheet(150, { arrangement: MINIMUM_LABELS, onCall: MINIMUM_LABELS }),
      hasPredictions: false,
    });
    expect(status.partial).toBe(false);
    expect(status.complete).toBe(false);
  });

  it("reports a question the sheet has no column for as stale", () => {
    const status = goldenSetStatus({
      questions: [...QUESTIONS, { id: "sponsorship", options: ["offers", "not_mentioned"] }],
      sheet: sheet(150, { arrangement: MINIMUM_LABELS, onCall: MINIMUM_LABELS }),
      hasPredictions: true,
    });
    expect(status.missingColumns).toEqual(["sponsorship"]);
    expect(status.complete).toBe(false);
    expect(status.reason).toContain("needs sampling again");
  });

  it("keeps empty cells as labels, so they are counted and excluded when scoring", () => {
    const status = goldenSetStatus({
      questions: QUESTIONS,
      sheet: sheet(2, { arrangement: 1 }),
      hasPredictions: true,
    });
    expect(status.labels).toEqual([
      { posting: "p0", question: "arrangement", option: "remote" },
      { posting: "p0", question: "onCall", option: "" },
      { posting: "p1", question: "arrangement", option: "" },
      { posting: "p1", question: "onCall", option: "" },
    ]);
  });

  it("skips a row with no posting id", () => {
    const status = goldenSetStatus({
      questions: QUESTIONS,
      sheet: 'id,company,arrangement,onCall\n,Acme,remote,no\n"  ",Acme,remote,no\n',
      hasPredictions: true,
    });
    expect(status.labels).toEqual([]);
    expect(status.labelled).toEqual({ arrangement: 0, onCall: 0 });
  });

  it("reads no labels from a sheet with no id column", () => {
    const status = goldenSetStatus({
      questions: QUESTIONS,
      sheet: "company,arrangement,onCall\nAcme,remote,no\n",
      hasPredictions: true,
    });
    expect(status.labels).toEqual([]);
  });

  it("is not complete when there are no questions to score", () => {
    const status = goldenSetStatus({ questions: [], sheet: "id\n", hasPredictions: true });
    expect(status.complete).toBe(false);
  });
});
