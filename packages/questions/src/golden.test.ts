import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, inject, it } from "vitest";
import {
  type AnswerPrediction,
  type QuestionOptions,
  renderScore,
  scoreQuestion,
} from "./accuracy.ts";
import { goldenSetStatus, MINIMUM_LABELS } from "./golden-set.ts";
import { answerShapes } from "./index.ts";

/**
 * How accurate and how well calibrated the standard questions' answers are, against postings
 * answered by hand.
 *
 * Two files in `fixtures` hold the set, both produced by `pipeline sample-answers`, which costs
 * nothing because enrichment has already paid for the answers:
 *
 * - `answers-golden.csv`, the sheet, with one column per question for a person to fill in;
 * - `answers-predictions.json`, what the model said about those same postings.
 *
 * Like the location golden set, the floors sit below the measured score, so one posting moving
 * does not fail a build, and a failure prints which postings disagree rather than only that a
 * number dropped. Raise a floor when the questions improve. Lowering one means a label in the
 * set is wrong, not that the model may be.
 *
 * ## Why this may skip, and how to make it loud
 *
 * The sheet is in the repository, and is not labelled yet. So the gate is how many labels it
 * holds, not whether the files are there: a presence check went true the moment the sheet
 * landed, and would score a sheet with nothing in it. A question with fewer than
 * `MINIMUM_LABELS` labels is reported as skipped rather than passed, because a test that passes
 * by not running is the failure this guards against.
 *
 * `QUARRY_REQUIRE_GOLDEN=1` turns the absent set into a failure, so that a run can tell "the
 * accuracy check passed" from "the accuracy check did not happen". It is off by default because
 * the labels genuinely are not written yet and an ordinary `pnpm test` must pass; CI reports the
 * state instead, and gains the flag once every question is labelled. The arithmetic itself is
 * covered either way by `accuracy.test.ts`, which needs no data.
 *
 * Nothing claims a number in the meantime: the README says accuracy is not measured yet, and
 * the site shows bands whose cuts the code itself calls provisional.
 */
const FIXTURES = join(dirname(dirname(fileURLToPath(import.meta.url))), "fixtures");
const LABELS = join(FIXTURES, "answers-golden.csv");
const PREDICTIONS = join(FIXTURES, "answers-predictions.json");

/**
 * The least each question must score once it is labelled. These are placeholders, to be set
 * from what is actually measured.
 *
 * Read them next to the `majorityShare` the score reports. On a sample of this corpus one
 * option dominates both sponsorship and on call, so always answering it scores above 90%,
 * which is above the two floors below: as written, neither can fail a model that learned
 * nothing. Set each floor from the measurement, above the base rate, not from these.
 */
const FLOORS: Readonly<Record<string, { accuracy: number; calibrationError: number }>> = {
  arrangement: { accuracy: 0.8, calibrationError: 0.15 },
  seniority: { accuracy: 0.6, calibrationError: 0.2 },
  sponsorship: { accuracy: 0.8, calibrationError: 0.15 },
  onCall: { accuracy: 0.8, calibrationError: 0.15 },
};

interface Recorded {
  readonly questions: readonly (QuestionOptions & { readonly id: string })[];
  readonly predictions: readonly AnswerPrediction[];
}

const shapes = answerShapes();
const sheet = existsSync(LABELS) ? readFileSync(LABELS, "utf8") : null;
const recorded: Recorded | null = existsSync(PREDICTIONS)
  ? (JSON.parse(readFileSync(PREDICTIONS, "utf8")) as Recorded)
  : null;
const status = goldenSetStatus({
  questions: shapes,
  sheet,
  hasPredictions: recorded !== null,
});
// Set from QUARRY_REQUIRE_GOLDEN in `vitest.config.ts`, which is where the environment is read.
const required = inject("requireGoldenSet");

describe("the standard questions' accuracy set", () => {
  // Runs only when asked for, so that a clone with an unlabelled sheet still passes, and a run
  // that wants the guarantee gets a failure rather than a silence.
  it.runIf(required)("is labelled, as QUARRY_REQUIRE_GOLDEN=1 requires", () => {
    expect(status.complete, `The accuracy set cannot be scored: ${status.reason}`).toBe(true);
  });

  it.skipIf(sheet === null)("has a column for every question", () => {
    // A sheet sampled against a different set of questions cannot be scored against this one,
    // and the labels in it were written about different columns.
    expect(status.missingColumns, status.reason).toEqual([]);
  });

  it.skipIf(sheet === null)("labels no option a question does not have", () => {
    const allowed = new Map(shapes.map((shape) => [shape.id, shape.options]));
    const unknown = status.labels
      .filter(
        (label) =>
          label.option !== "" && !(allowed.get(label.question) ?? []).includes(label.option),
      )
      .map((label) => `${label.posting} ${label.question}=${label.option}`);
    expect(unknown).toEqual([]);
  });

  it.skipIf(recorded === null)("recorded the questions as they are asked now", () => {
    // The distributions are stored in option order, so a reordered or renamed option would be
    // scored against the wrong label. Re-sample the pair rather than editing either file.
    expect(recorded?.questions).toEqual(shapes);
  });
});

describe.skipIf(!status.partial)("the standard questions, against hand-labelled postings", () => {
  const predictions = recorded?.predictions ?? [];
  for (const question of recorded?.questions ?? []) {
    const floor = FLOORS[question.id];
    const enough = (status.labelled[question.id] ?? 0) >= MINIMUM_LABELS;
    // Skipped, not passed: below the minimum a percentage is noise, and a green test here would
    // say the question was measured when it was not.
    const test = enough && floor !== undefined ? it : it.skip;
    test(`${question.id} is at least as accurate and as well calibrated as its floor`, () => {
      const score = scoreQuestion(question, status.labels, predictions);
      if (floor === undefined) return;
      // The report is the interesting output: on a failure it says which postings moved.
      const report = `${renderScore(score)}\nWorst disagreements:\n${score.disagreements
        .slice(0, 10)
        .map(
          (entry) =>
            `  ${entry.posting}: said ${entry.picked} (${entry.confidence}%), labelled ${entry.expected} (${entry.expectedProbability}%)`,
        )
        .join("\n")}`;
      expect(score.compared, report).toBeGreaterThanOrEqual(MINIMUM_LABELS);
      expect(score.accuracy, report).toBeGreaterThanOrEqual(floor.accuracy);
      expect(score.calibrationError, report).toBeLessThanOrEqual(floor.calibrationError);
    });
  }
});
