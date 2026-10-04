/**
 * How good the standard questions' answers are, measured against answers a person gave.
 *
 * The README says results are grouped into likely, maybe, and unlikely. That grouping is a claim
 * about calibration: that an answer the model calls 80% likely is right about 80% of the time.
 * Nothing had measured it, and the site's band cuts were chosen by eye. This is the arithmetic
 * that replaces the guess.
 *
 * It is deliberately pure: labels in, numbers out. Getting the model's answers in the first
 * place costs money and needs a key, so that belongs in a script that records them once; this
 * runs for free, in CI, over what was recorded.
 */

/** A probability in hundredths, as the index stores them. */
export type Centi = number;

/** What a person says the answer is for one posting and one question. */
export interface AnswerLabel {
  /** Whatever identifies the posting, the same way the prediction does. */
  readonly posting: string;
  readonly question: string;
  /**
   * The option id a person judged correct, or an empty string when they could not tell from the
   * posting. Those are counted and excluded: a posting a careful reader cannot answer is not a
   * fair test of the model, and silently scoring it either way would flatter or punish it.
   */
  readonly option: string;
}

/** What the model said: a probability per option, in the question's own option order. */
export interface AnswerPrediction {
  readonly posting: string;
  readonly question: string;
  readonly distribution: readonly Centi[];
}

/** The options one question distributes over, in order. Normally from `answerShapes()`. */
export interface QuestionOptions {
  readonly id: string;
  readonly options: readonly string[];
}

/** One bucket of a reliability diagram: what the model claimed, against what happened. */
export interface CalibrationBucket {
  /** Bounds on the confidence in the picked option, in hundredths; `to` is exclusive except at 100. */
  readonly from: Centi;
  readonly to: Centi;
  readonly count: number;
  /** Mean confidence the model had in the option it picked, in hundredths. */
  readonly meanConfidence: number;
  /** Share of those it got right, 0 to 1. */
  readonly accuracy: number;
}

/** What showing answers only above a threshold would cost and buy. */
export interface ThresholdPoint {
  readonly atLeast: Centi;
  /** Share of compared answers whose picked option reaches the threshold, 0 to 1. */
  readonly coverage: number;
  /** Accuracy among those, 0 to 1; NaN when none reach it. */
  readonly accuracy: number;
}

/** A posting the model and the person disagreed about, worst first. */
export interface Disagreement {
  readonly posting: string;
  /** The option the model picked, and how sure it was. */
  readonly picked: string;
  readonly confidence: Centi;
  /** The option the person gave, and what the model thought of it. */
  readonly expected: string;
  readonly expectedProbability: Centi;
}

export interface QuestionScore {
  readonly question: string;
  /** Labelled postings whose answer the model also gave. */
  readonly compared: number;
  /** Labels a person could not answer, excluded from every number here. */
  readonly unlabelled: number;
  /** Labels naming an option the question does not have: a labelling mistake, not a result. */
  readonly invalid: number;
  /** Labels with no model answer to compare against. */
  readonly unanswered: number;
  /** Share where the likeliest option is the labelled one, 0 to 1. */
  readonly accuracy: number;
  /**
   * Mean probability the model put on the right option. Unlike accuracy it reads the whole
   * distribution, so being wrong but unsure scores better than being wrong and certain.
   */
  readonly meanTruthProbability: number;
  /**
   * Multiclass Brier score, 0 (perfect) to 2 (confidently wrong every time). A proper score, so
   * it cannot be improved by overstating or hedging confidence.
   */
  readonly brier: number;
  readonly buckets: readonly CalibrationBucket[];
  /**
   * Expected calibration error, 0 to 1: the count-weighted gap between claimed confidence and
   * observed accuracy. This is the number that says whether a probability can be trusted as a
   * probability, which is the whole premise of filtering by one.
   */
  readonly calibrationError: number;
  readonly thresholds: readonly ThresholdPoint[];
  readonly disagreements: readonly Disagreement[];
}

/** Default confidence buckets: tenths, since a bucket needs enough items to mean anything. */
const BUCKET_WIDTH = 10;

/** Thresholds reported, matching the ones the site offers. */
const THRESHOLDS: readonly Centi[] = [50, 60, 70, 80, 90];

/** The likeliest option, lowest index breaking a tie so the result is deterministic. */
function picked(distribution: readonly Centi[]): number {
  let best = 0;
  for (let option = 1; option < distribution.length; option += 1) {
    if ((distribution[option] ?? 0) > (distribution[best] ?? 0)) best = option;
  }
  return best;
}

interface Compared {
  readonly posting: string;
  readonly distribution: readonly Centi[];
  readonly expected: number;
  readonly picked: number;
  readonly confidence: Centi;
  readonly truth: Centi;
}

function buckets(compared: readonly Compared[]): CalibrationBucket[] {
  const result: CalibrationBucket[] = [];
  for (let from = 0; from < 100; from += BUCKET_WIDTH) {
    const to = from + BUCKET_WIDTH;
    // The top bucket closes at 100, so a certain answer is not dropped.
    const members = compared.filter(
      (entry) =>
        entry.confidence >= from && (to === 100 ? entry.confidence <= to : entry.confidence < to),
    );
    if (members.length === 0) continue;
    const right = members.filter((entry) => entry.picked === entry.expected).length;
    const confidence = members.reduce((sum, entry) => sum + entry.confidence, 0) / members.length;
    result.push({
      from,
      to,
      count: members.length,
      meanConfidence: confidence,
      accuracy: right / members.length,
    });
  }
  return result;
}

function thresholdPoints(compared: readonly Compared[]): ThresholdPoint[] {
  return THRESHOLDS.map((atLeast) => {
    const kept = compared.filter((entry) => entry.confidence >= atLeast);
    const right = kept.filter((entry) => entry.picked === entry.expected).length;
    return {
      atLeast,
      coverage: compared.length === 0 ? 0 : kept.length / compared.length,
      accuracy: kept.length === 0 ? Number.NaN : right / kept.length,
    };
  });
}

/**
 * Scores one question's answers against the labels. Postings are matched by id, so labels and
 * predictions may arrive in any order and either may be missing entries; what could not be
 * compared is counted rather than dropped quietly.
 */
export function scoreQuestion(
  question: QuestionOptions,
  labels: readonly AnswerLabel[],
  predictions: readonly AnswerPrediction[],
): QuestionScore {
  const mine = labels.filter((label) => label.question === question.id);
  const byPosting = new Map(
    predictions
      .filter((prediction) => prediction.question === question.id)
      .map((prediction) => [prediction.posting, prediction]),
  );

  let unlabelled = 0;
  let invalid = 0;
  let unanswered = 0;
  const compared: Compared[] = [];
  for (const label of mine) {
    if (label.option === "") {
      unlabelled += 1;
      continue;
    }
    const expected = question.options.indexOf(label.option);
    if (expected < 0) {
      invalid += 1;
      continue;
    }
    const prediction = byPosting.get(label.posting);
    // A distribution of the wrong width is not this question's answer, so it is not compared.
    if (prediction === undefined || prediction.distribution.length !== question.options.length) {
      unanswered += 1;
      continue;
    }
    const best = picked(prediction.distribution);
    compared.push({
      posting: label.posting,
      distribution: prediction.distribution,
      expected,
      picked: best,
      confidence: prediction.distribution[best] ?? 0,
      truth: prediction.distribution[expected] ?? 0,
    });
  }

  const right = compared.filter((entry) => entry.picked === entry.expected).length;
  const mean = (values: readonly number[]) =>
    values.length === 0
      ? Number.NaN
      : values.reduce((sum, value) => sum + value, 0) / values.length;
  const brierOf = (entry: Compared) =>
    entry.distribution.reduce((sum, probability, option) => {
      const actual = option === entry.expected ? 1 : 0;
      return sum + (probability / 100 - actual) ** 2;
    }, 0);
  const spread = buckets(compared);
  const error =
    compared.length === 0
      ? Number.NaN
      : spread.reduce(
          (sum, bucket) =>
            sum +
            (bucket.count / compared.length) *
              Math.abs(bucket.meanConfidence / 100 - bucket.accuracy),
          0,
        );

  return {
    question: question.id,
    compared: compared.length,
    unlabelled,
    invalid,
    unanswered,
    accuracy: compared.length === 0 ? Number.NaN : right / compared.length,
    meanTruthProbability: mean(compared.map((entry) => entry.truth / 100)),
    brier: mean(compared.map(brierOf)),
    buckets: spread,
    calibrationError: error,
    thresholds: thresholdPoints(compared),
    // Worst first: the model was most certain where it was most wrong.
    disagreements: compared
      .filter((entry) => entry.picked !== entry.expected)
      .sort(
        (left, right) =>
          right.confidence - left.confidence || left.posting.localeCompare(right.posting),
      )
      .map((entry) => ({
        posting: entry.posting,
        picked: question.options[entry.picked] ?? "",
        confidence: entry.confidence,
        expected: question.options[entry.expected] ?? "",
        expectedProbability: entry.truth,
      })),
  };
}

/** Scores every question, in the order given. */
export function scoreAnswers(
  questions: readonly QuestionOptions[],
  labels: readonly AnswerLabel[],
  predictions: readonly AnswerPrediction[],
): QuestionScore[] {
  return questions.map((question) => scoreQuestion(question, labels, predictions));
}

/** A score as a Markdown section, for a report or a job summary. */
export function renderScore(score: QuestionScore): string {
  const percent = (value: number) => (Number.isNaN(value) ? "n/a" : `${(100 * value).toFixed(1)}%`);
  const lines = [
    `### ${score.question}`,
    "",
    `- ${score.compared} compared: accuracy ${percent(score.accuracy)}, mean probability on the right answer ${percent(score.meanTruthProbability)}.`,
    `- Brier ${Number.isNaN(score.brier) ? "n/a" : score.brier.toFixed(3)}, calibration error ${percent(score.calibrationError)}.`,
  ];
  const skipped: string[] = [];
  if (score.unlabelled > 0) skipped.push(`${score.unlabelled} a reader could not answer`);
  if (score.unanswered > 0) skipped.push(`${score.unanswered} with no model answer`);
  if (score.invalid > 0) skipped.push(`${score.invalid} labelled with an unknown option`);
  if (skipped.length > 0) lines.push(`- Excluded: ${skipped.join(", ")}.`);
  if (score.thresholds.length > 0) {
    lines.push("", "| Shown above | Kept | Accuracy |", "| --- | ---: | ---: |");
    for (const point of score.thresholds) {
      lines.push(`| ${point.atLeast}% | ${percent(point.coverage)} | ${percent(point.accuracy)} |`);
    }
  }
  if (score.buckets.length > 0) {
    lines.push("", "| Confidence | Count | Claimed | Observed |", "| --- | ---: | ---: | ---: |");
    for (const bucket of score.buckets) {
      lines.push(
        `| ${bucket.from} to ${bucket.to}% | ${bucket.count} | ${bucket.meanConfidence.toFixed(1)}% | ${percent(bucket.accuracy)} |`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}
