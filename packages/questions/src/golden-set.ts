/**
 * Whether the standard questions' accuracy set can be scored yet, and what is missing when it
 * cannot.
 *
 * This exists so that one answer serves two callers: `golden.test.ts`, which must skip rather
 * than score a sheet nobody has filled in, and `scripts/report-golden-set.ts`, which says in CI
 * whether the accuracy check ran at all. Those two must never disagree, so neither owns the rule.
 *
 * It is pure: text in, counts out. Reading the files is the caller's job, which keeps this
 * importable from anywhere and testable without fixtures.
 *
 * The rule is deliberately "enough labels", not "the files are there". The sheet is committed
 * unlabelled, so a presence check is true from the moment it lands and would wave through a
 * sheet with nothing in it.
 */
import type { AnswerLabel, QuestionOptions } from "./accuracy.ts";

/**
 * The fewest labels one question needs before its score says anything. Below this a percentage
 * is noise: a single posting moving swings it by more than any change worth noticing.
 */
export const MINIMUM_LABELS = 30;

export interface GoldenSetStatus {
  readonly hasSheet: boolean;
  readonly hasPredictions: boolean;
  /** How many cells a person has filled in, per question id. */
  readonly labelled: Readonly<Record<string, number>>;
  /** Questions with no column in the sheet at all, which means the sheet is stale. */
  readonly missingColumns: readonly string[];
  /** Every cell as a label, empty ones included: those are counted and excluded when scoring. */
  readonly labels: readonly AnswerLabel[];
  /** At least one question can be scored, so the suite has something to measure. */
  readonly partial: boolean;
  /** Every question can be scored, which is the only state in which "accuracy passed" is true. */
  readonly complete: boolean;
  /** One line saying where the set stands, for a test failure or a CI summary. */
  readonly reason: string;
}

/** RFC 4180 fields: quoted fields may hold commas, doubled quotes, and line breaks. */
export function parseCsv(text: string): string[][] {
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

/**
 * Reads the labelling sheet and says whether there is anything to score.
 *
 * `questions` is the live set, not the one the sheet was sampled against, so a sheet gone stale
 * against a question that was added or renamed shows up as a missing column rather than as a
 * question that quietly scores nothing.
 */
export function goldenSetStatus(input: {
  readonly questions: readonly QuestionOptions[];
  /** The sheet's CSV text, or null when the file is not there. */
  readonly sheet: string | null;
  /** Whether the predictions file is there. Its contents are not needed to answer this. */
  readonly hasPredictions: boolean;
}): GoldenSetStatus {
  const { questions, sheet, hasPredictions } = input;
  const rows = sheet === null ? [] : parseCsv(sheet);
  const [header = [], ...body] = rows;

  const labelled: Record<string, number> = {};
  const missingColumns: string[] = [];
  const labels: AnswerLabel[] = [];
  const columns = new Map<string, number>();
  for (const question of questions) {
    labelled[question.id] = 0;
    const at = header.indexOf(question.id);
    if (at < 0) {
      if (sheet !== null) missingColumns.push(question.id);
      continue;
    }
    columns.set(question.id, at);
  }

  const id = header.indexOf("id");
  for (const row of body) {
    const posting = id < 0 ? "" : (row[id] ?? "").trim();
    if (posting === "") continue;
    for (const [question, at] of columns) {
      const option = (row[at] ?? "").trim();
      labels.push({ posting, question, option });
      if (option !== "") labelled[question] = (labelled[question] ?? 0) + 1;
    }
  }

  const counts = questions.map((question) => labelled[question.id] ?? 0);
  const enough = counts.filter((count) => count >= MINIMUM_LABELS).length;
  const partial = hasPredictions && enough > 0;
  const complete = hasPredictions && questions.length > 0 && enough === questions.length;

  return {
    hasSheet: sheet !== null,
    hasPredictions,
    labelled,
    missingColumns,
    labels,
    partial,
    complete,
    reason: describe({ sheet, hasPredictions, questions, labelled, missingColumns, enough }),
  };
}

function describe(input: {
  readonly sheet: string | null;
  readonly hasPredictions: boolean;
  readonly questions: readonly QuestionOptions[];
  readonly labelled: Readonly<Record<string, number>>;
  readonly missingColumns: readonly string[];
  readonly enough: number;
}): string {
  const { sheet, hasPredictions, questions, labelled, missingColumns, enough } = input;
  const missing: string[] = [];
  if (sheet === null) missing.push("the labelling sheet");
  if (!hasPredictions) missing.push("the predictions file");
  if (missing.length > 0) {
    return `${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not there. Run \`pipeline sample-answers\` against an enriched store.`;
  }
  const spread = questions
    .map((question) => `${question.id} ${labelled[question.id] ?? 0}`)
    .join(", ");
  const stale =
    missingColumns.length > 0
      ? ` The sheet has no column for ${missingColumns.join(", ")}, so it was sampled against a different set of questions and needs sampling again.`
      : "";
  return `${enough} of ${questions.length} questions have ${MINIMUM_LABELS} or more labels (${spread}).${stale}`;
}
