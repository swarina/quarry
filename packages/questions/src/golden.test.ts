import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type AnswerLabel,
  type AnswerPrediction,
  type QuestionOptions,
  renderScore,
  scoreQuestion,
} from "./accuracy.ts";

/**
 * How accurate and how well calibrated the standard questions' answers are, against postings
 * answered by hand.
 *
 * The two files are produced by `pipeline sample-answers`, which costs nothing because
 * enrichment has already paid for the answers, and then filled in by a person:
 *
 * - `fixtures/answers-golden.csv`, the labels;
 * - `fixtures/answers-predictions.json`, what the model said.
 *
 * Like the location golden set, the floors sit below the measured score, so one posting moving
 * does not fail a build, and a failure prints which postings disagree rather than only that a
 * number dropped. Raise a floor when the questions improve. Lowering one means a label in the
 * set is wrong, not that the model may be.
 *
 * ## Why this may skip
 *
 * Until the sheet is labelled there is nothing to measure, and this skips. That is sound only
 * because nothing claims a number in the meantime: the README says accuracy is not measured yet
 * (ADR-0026), and the site shows bands whose cuts the code itself calls provisional. The
 * arithmetic here is covered either way by `accuracy.test.ts`, which does not need the data.
 * If a published accuracy figure ever appears, this must become a test that fails when absent.
 */
const FIXTURES = join(dirname(dirname(fileURLToPath(import.meta.url))), "fixtures");
const LABELS = join(FIXTURES, "answers-golden.csv");
const PREDICTIONS = join(FIXTURES, "answers-predictions.json");

/** The least each question must score once the set exists. Raise as the questions improve. */
const FLOORS: Readonly<Record<string, { accuracy: number; calibrationError: number }>> = {
  arrangement: { accuracy: 0.8, calibrationError: 0.15 },
  seniority: { accuracy: 0.6, calibrationError: 0.2 },
  sponsorship: { accuracy: 0.8, calibrationError: 0.15 },
  onCall: { accuracy: 0.8, calibrationError: 0.15 },
};

/** The fewest labels worth drawing a conclusion from; below it a score is noise. */
const MINIMUM_LABELS = 30;

/** RFC 4180 fields: quoted fields may hold commas, doubled quotes, and line breaks. */
function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else quoted = false;
      } else field += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") {
      record.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else field += character;
  }
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

const present = existsSync(LABELS) && existsSync(PREDICTIONS);

describe.skipIf(!present)("the standard questions, against hand-labelled postings", () => {
  const recorded = present
    ? (JSON.parse(readFileSync(PREDICTIONS, "utf8")) as {
        questions: (QuestionOptions & { id: string })[];
        predictions: AnswerPrediction[];
      })
    : { questions: [], predictions: [] };
  const rows = present ? parseCsv(readFileSync(LABELS, "utf8")) : [];
  const [header = [], ...body] = rows;

  const labels: AnswerLabel[] = [];
  for (const row of body) {
    const id = row[header.indexOf("id")] ?? "";
    if (id === "") continue;
    for (const question of recorded.questions) {
      const at = header.indexOf(question.id);
      if (at < 0) continue;
      labels.push({ posting: id, question: question.id, option: (row[at] ?? "").trim() });
    }
  }

  it("has enough labels to draw a conclusion from", () => {
    const answered = labels.filter((label) => label.option !== "");
    expect(answered.length).toBeGreaterThanOrEqual(MINIMUM_LABELS);
  });

  it("labels no option a question does not have", () => {
    const wrong = recorded.questions.flatMap((question) =>
      scoreQuestion(question, labels, recorded.predictions).invalid > 0 ? [question.id] : [],
    );
    expect(wrong).toEqual([]);
  });

  it.each(recorded.questions.map((question) => [question.id, question] as const))(
    "%s is at least as accurate and as well calibrated as its floor",
    (id, question) => {
      const score = scoreQuestion(question, labels, recorded.predictions);
      const floor = FLOORS[id];
      if (floor === undefined || score.compared === 0) return;
      // The report is the interesting output: on a failure it says which postings moved.
      const report = `${renderScore(score)}\nWorst disagreements:\n${score.disagreements
        .slice(0, 10)
        .map(
          (entry) =>
            `  ${entry.posting}: said ${entry.picked} (${entry.confidence}%), labelled ${entry.expected} (${entry.expectedProbability}%)`,
        )
        .join("\n")}`;
      expect(score.accuracy, report).toBeGreaterThanOrEqual(floor.accuracy);
      expect(score.calibrationError, report).toBeLessThanOrEqual(floor.calibrationError);
    },
  );
});
