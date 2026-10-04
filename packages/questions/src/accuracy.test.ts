import { describe, expect, it } from "vitest";
import {
  type AnswerLabel,
  type AnswerPrediction,
  type QuestionOptions,
  renderScore,
  scoreAnswers,
  scoreQuestion,
} from "./accuracy.ts";

const ARRANGEMENT: QuestionOptions = {
  id: "arrangement",
  options: ["remote", "hybrid", "onsite"],
};

const label = (posting: string, option: string, question = "arrangement"): AnswerLabel => ({
  posting,
  question,
  option,
});
const predict = (
  posting: string,
  distribution: number[],
  question = "arrangement",
): AnswerPrediction => ({ posting, question, distribution });

describe("scoring a question", () => {
  it("counts an answer right when the likeliest option is the labelled one", () => {
    const score = scoreQuestion(
      ARRANGEMENT,
      [label("1", "remote"), label("2", "onsite")],
      [predict("1", [80, 15, 5]), predict("2", [10, 20, 70])],
    );
    expect(score.compared).toBe(2);
    expect(score.accuracy).toBe(1);
    expect(score.meanTruthProbability).toBeCloseTo(0.75, 5);
  });

  it("counts an answer wrong however sure the model was", () => {
    const score = scoreQuestion(ARRANGEMENT, [label("1", "onsite")], [predict("1", [95, 3, 2])]);
    expect(score.accuracy).toBe(0);
    expect(score.meanTruthProbability).toBeCloseTo(0.02, 5);
  });

  it("reads the whole distribution, so being wrong but unsure scores better", () => {
    const certain = scoreQuestion(ARRANGEMENT, [label("1", "onsite")], [predict("1", [95, 3, 2])]);
    const unsure = scoreQuestion(ARRANGEMENT, [label("1", "onsite")], [predict("1", [40, 25, 35])]);
    // Both are wrong by accuracy; only a proper score tells them apart.
    expect(certain.accuracy).toBe(unsure.accuracy);
    expect(unsure.brier).toBeLessThan(certain.brier);
    expect(unsure.meanTruthProbability).toBeGreaterThan(certain.meanTruthProbability);
  });

  it("gives a perfect answer a Brier of zero and a certainly wrong one two", () => {
    expect(
      scoreQuestion(ARRANGEMENT, [label("1", "remote")], [predict("1", [100, 0, 0])]).brier,
    ).toBeCloseTo(0, 10);
    expect(
      scoreQuestion(ARRANGEMENT, [label("1", "onsite")], [predict("1", [100, 0, 0])]).brier,
    ).toBeCloseTo(2, 10);
  });

  it("breaks a tie on the lowest option, so a score does not wander between runs", () => {
    const first = scoreQuestion(ARRANGEMENT, [label("1", "remote")], [predict("1", [50, 50, 0])]);
    const again = scoreQuestion(ARRANGEMENT, [label("1", "remote")], [predict("1", [50, 50, 0])]);
    expect(first.accuracy).toBe(1);
    expect(again.accuracy).toBe(first.accuracy);
  });
});

describe("what cannot be compared", () => {
  it("excludes a posting a reader could not answer, and says how many", () => {
    const score = scoreQuestion(
      ARRANGEMENT,
      [label("1", "remote"), label("2", "")],
      [predict("1", [80, 15, 5]), predict("2", [10, 20, 70])],
    );
    expect(score.unlabelled).toBe(1);
    expect(score.compared).toBe(1);
    expect(score.accuracy).toBe(1);
  });

  it("counts a label naming an option the question does not have as a labelling mistake", () => {
    const score = scoreQuestion(ARRANGEMENT, [label("1", "wfh")], [predict("1", [80, 15, 5])]);
    expect(score.invalid).toBe(1);
    expect(score.compared).toBe(0);
    expect(score.accuracy).toBeNaN();
  });

  it("counts a label with no model answer rather than scoring it", () => {
    const score = scoreQuestion(ARRANGEMENT, [label("1", "remote")], []);
    expect(score.unanswered).toBe(1);
    expect(score.compared).toBe(0);
  });

  it("refuses a distribution of the wrong width, which is another question's answer", () => {
    const score = scoreQuestion(ARRANGEMENT, [label("1", "remote")], [predict("1", [50, 50])]);
    expect(score.unanswered).toBe(1);
  });

  it("ignores labels and answers for other questions", () => {
    const score = scoreQuestion(
      ARRANGEMENT,
      [label("1", "remote"), label("1", "yes", "onCall")],
      [predict("1", [80, 15, 5]), predict("1", [20, 80], "onCall")],
    );
    expect(score.compared).toBe(1);
  });

  it("matches a label to its answer by posting, in any order", () => {
    const score = scoreQuestion(
      ARRANGEMENT,
      [label("2", "onsite"), label("1", "remote")],
      [predict("1", [80, 15, 5]), predict("2", [10, 20, 70])],
    );
    expect(score.compared).toBe(2);
    expect(score.accuracy).toBe(1);
  });

  it("reports nothing rather than zero when there is nothing to compare", () => {
    const score = scoreQuestion(ARRANGEMENT, [], []);
    expect(score.compared).toBe(0);
    // NaN, not 0: no measurement is not the same as an accuracy of nought.
    expect(score.accuracy).toBeNaN();
    expect(score.calibrationError).toBeNaN();
    expect(score.buckets).toEqual([]);
  });
});

describe("calibration", () => {
  /** `right` answers at `confidence`, then `wrong` at the same confidence. */
  function run(confidence: number, right: number, wrong: number): AnswerPrediction[] {
    const rest = (100 - confidence) / 2;
    const out: AnswerPrediction[] = [];
    for (let at = 0; at < right + wrong; at += 1) {
      out.push(predict(`p${at}`, [confidence, rest, rest]));
    }
    return out;
  }
  function labels(right: number, wrong: number): AnswerLabel[] {
    const out: AnswerLabel[] = [];
    for (let at = 0; at < right; at += 1) out.push(label(`p${at}`, "remote"));
    for (let at = right; at < right + wrong; at += 1) out.push(label(`p${at}`, "hybrid"));
    return out;
  }

  it("calls a model that is right exactly as often as it claims perfectly calibrated", () => {
    // 80% confident, right 8 of 10.
    const score = scoreQuestion(ARRANGEMENT, labels(8, 2), run(80, 8, 2));
    expect(score.accuracy).toBeCloseTo(0.8, 10);
    expect(score.calibrationError).toBeCloseTo(0, 10);
  });

  it("measures how far an overconfident model is from the truth", () => {
    // 90% confident, right only half the time: a 40 point gap.
    const score = scoreQuestion(ARRANGEMENT, labels(5, 5), run(90, 5, 5));
    expect(score.calibrationError).toBeCloseTo(0.4, 10);
  });

  it("buckets by confidence in tenths, and keeps a certain answer in the top bucket", () => {
    const score = scoreQuestion(
      ARRANGEMENT,
      [label("1", "remote"), label("2", "remote")],
      [predict("1", [100, 0, 0]), predict("2", [45, 30, 25])],
    );
    expect(score.buckets.map((bucket) => [bucket.from, bucket.to, bucket.count])).toEqual([
      [40, 50, 1],
      [90, 100, 1],
    ]);
  });

  it("weights each bucket by how many answers are in it", () => {
    // Ten perfectly calibrated answers at 90 (nine right), plus one badly wrong at 50. On its
    // own that outlier is a gap of 0.5; as one of eleven it is worth a eleventh of that.
    const outlier = scoreQuestion(
      ARRANGEMENT,
      [label("x", "onsite")],
      [predict("x", [50, 25, 25])],
    );
    expect(outlier.calibrationError).toBeCloseTo(0.5, 10);

    const score = scoreQuestion(
      ARRANGEMENT,
      [...labels(9, 1), label("x", "onsite")],
      [...run(90, 9, 1), predict("x", [50, 25, 25])],
    );
    expect(score.calibrationError).toBeCloseTo(0.5 / 11, 10);
  });
});

describe("what a threshold would cost", () => {
  it("says what share is kept and how accurate it is at each cut", () => {
    const score = scoreQuestion(
      ARRANGEMENT,
      [label("1", "remote"), label("2", "remote"), label("3", "hybrid"), label("4", "remote")],
      [
        predict("1", [95, 3, 2]),
        predict("2", [85, 10, 5]),
        // Wrong, and only just over half sure.
        predict("3", [55, 25, 20]),
        predict("4", [52, 24, 24]),
      ],
    );
    const at = (value: number) => score.thresholds.find((point) => point.atLeast === value);
    expect(at(50)).toMatchObject({ coverage: 1, accuracy: 0.75 });
    // Above 80 only the two confident ones remain, and both are right.
    expect(at(80)).toMatchObject({ coverage: 0.5, accuracy: 1 });
    expect(at(90)).toMatchObject({ coverage: 0.25, accuracy: 1 });
  });

  it("reports no accuracy rather than a perfect one when a cut keeps nothing", () => {
    const score = scoreQuestion(ARRANGEMENT, [label("1", "remote")], [predict("1", [55, 25, 20])]);
    const top = score.thresholds.find((point) => point.atLeast === 90);
    expect(top?.coverage).toBe(0);
    expect(top?.accuracy).toBeNaN();
  });
});

describe("disagreements", () => {
  it("lists the confident mistakes first, which are the ones worth reading", () => {
    const score = scoreQuestion(
      ARRANGEMENT,
      [label("sure", "onsite"), label("unsure", "onsite"), label("right", "remote")],
      [
        predict("sure", [92, 5, 3]),
        predict("unsure", [45, 30, 25]),
        predict("right", [80, 10, 10]),
      ],
    );
    expect(score.disagreements.map((entry) => entry.posting)).toEqual(["sure", "unsure"]);
    expect(score.disagreements[0]).toEqual({
      posting: "sure",
      picked: "remote",
      confidence: 92,
      expected: "onsite",
      expectedProbability: 3,
    });
  });
});

describe("scoring every question", () => {
  it("keeps the order asked for", () => {
    const questions: QuestionOptions[] = [{ id: "onCall", options: ["no", "yes"] }, ARRANGEMENT];
    const scores = scoreAnswers(questions, [label("1", "remote")], [predict("1", [80, 15, 5])]);
    expect(scores.map((score) => score.question)).toEqual(["onCall", "arrangement"]);
  });
});

describe("the report", () => {
  const score = scoreQuestion(
    ARRANGEMENT,
    [label("1", "remote"), label("2", "onsite"), label("3", "")],
    [predict("1", [95, 3, 2]), predict("2", [60, 20, 20])],
  );

  it("names the numbers a reader needs, and what was left out", () => {
    const text = renderScore(score);
    expect(text).toContain("### arrangement");
    expect(text).toContain("2 compared");
    expect(text).toContain("accuracy 50.0%");
    expect(text).toContain("a reader could not answer");
    expect(text).toContain("| Shown above | Kept | Accuracy |");
    expect(text).toContain("| Confidence | Count | Claimed | Observed |");
  });

  it("writes n/a rather than NaN when nothing was compared", () => {
    const text = renderScore(scoreQuestion(ARRANGEMENT, [], []));
    expect(text).toContain("n/a");
    expect(text).not.toContain("NaN");
  });

  it("uses no em dash, which the repository forbids", () => {
    expect(renderScore(score)).not.toContain(String.fromCodePoint(0x2014));
  });
});
