import { readAnswer } from "@quarry/facets";
import type { AnswerPrediction, AnswerShape } from "@quarry/questions";
import type { OpenPosting } from "@quarry/storage/node";

/**
 * Builds the pair of files the accuracy harness needs: what the model said, and a sheet for a
 * person to say what the answer really is.
 *
 * It costs nothing and needs no key, because enrichment has already paid for these answers and
 * the store kept them. Sampling after enrichment rather than asking again also means the
 * harness measures the answers the product actually serves.
 */

/** A row of the labelling sheet: enough to find and read the posting, and nowhere to hide. */
export interface SampleRow {
  readonly id: string;
  readonly company: string;
  readonly title: string;
  readonly url: string;
}

export interface AnswersSample {
  readonly rows: readonly SampleRow[];
  readonly predictions: readonly AnswerPrediction[];
  /** Postings considered, and how many held every wanted answer. */
  readonly considered: number;
  readonly answered: number;
}

/**
 * A stable pseudo-random order from the posting id, so the same store samples the same postings
 * however often this runs and a re-run adds no churn to the sheet.
 *
 * FNV-1a, then an avalanche step. Rearranging the id is not enough on its own, and neither is
 * FNV alone: its last operation is one multiply after the final byte, so ids differing only in
 * their last character come out in the same order they went in. The store returns postings
 * sorted by id, so the "sample" would have been the first few by id. The finalizer diffuses
 * every input bit across the whole result, which a quick check over sequential ids confirms.
 *
 * Cryptographic strength is not the point here, spreading is, and this is synchronous, which
 * the hashes in `@quarry/domain` are not.
 */
function shuffleKey(id: string): string {
  let hash = 0x811c9dc5;
  for (let at = 0; at < id.length; at += 1) {
    hash ^= id.charCodeAt(at);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b) >>> 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
  hash ^= hash >>> 16;
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Takes `size` postings that hold an answer to every question, in a stable order.
 *
 * Only fully answered postings are sampled. A sheet with gaps costs a person the same reading
 * time for less measurement, and a question answered for only part of the sample cannot be
 * compared against the others.
 */
export function sampleAnswers(
  postings: Iterable<OpenPosting>,
  shapes: readonly AnswerShape[],
  size: number,
): AnswersSample {
  const candidates: { row: SampleRow; predictions: AnswerPrediction[]; key: string }[] = [];
  let considered = 0;
  let answered = 0;
  for (const current of postings) {
    considered += 1;
    const predictions: AnswerPrediction[] = [];
    for (const shape of shapes) {
      const stored = current.answers[`${shape.id}@${shape.version}`];
      if (stored === undefined) continue;
      const distribution = readAnswer(stored, shape.kind, shape.options);
      if (distribution === null) continue;
      predictions.push({ posting: current.id, question: shape.id, distribution });
    }
    if (predictions.length !== shapes.length) continue;
    answered += 1;
    candidates.push({
      row: {
        id: current.id,
        company: current.company,
        title: current.posting.title,
        url: current.posting.url,
      },
      predictions,
      key: shuffleKey(current.id),
    });
  }

  const taken = candidates
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
    .slice(0, size);
  return {
    rows: taken.map((entry) => entry.row),
    predictions: taken.flatMap((entry) => entry.predictions),
    considered,
    answered,
  };
}

/** A CSV field, quoted the one way every reader agrees on. */
function field(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * The labelling sheet: one row per posting, one empty column per question. A person opens the
 * URL, reads the posting, and writes the option id they judge correct, or leaves it empty when
 * the posting does not say.
 *
 * The model's answer is deliberately not in the sheet. Showing it would anchor the person to it,
 * and a label that agrees because it was suggested measures nothing.
 */
export function renderLabelSheet(
  rows: readonly SampleRow[],
  shapes: readonly AnswerShape[],
): string {
  const header = ["id", "company", "title", "url", ...shapes.map((shape) => shape.id), "notes"];
  const lines = [header.map(field).join(",")];
  for (const row of rows) {
    lines.push(
      [row.id, row.company, row.title, row.url, ...shapes.map(() => ""), ""].map(field).join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

/** The options each question allows, as a comment block for whoever fills the sheet in. */
export function renderLabelGuide(shapes: readonly AnswerShape[]): string {
  const lines = [
    "# How to fill in the labelling sheet",
    "",
    "Open each posting's URL, read it, and write the option id you judge correct in that",
    "question's column. Leave a cell empty when the posting genuinely does not say: those are",
    "excluded from the score rather than counted against the model.",
    "",
    "Do not look at what the model answered first. A label that agrees because it was suggested",
    "measures nothing.",
    "",
  ];
  for (const shape of shapes) {
    lines.push(`## ${shape.id}`, "", `${shape.about}.`, "");
    for (const [at, option] of shape.options.entries()) {
      lines.push(`- \`${option}\`: ${shape.labels[at] ?? ""}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}
