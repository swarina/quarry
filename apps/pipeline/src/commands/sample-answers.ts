import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { answerShapes } from "@quarry/questions";
import { openPipelineStore } from "@quarry/storage/node";
import { renderLabelGuide, renderLabelSheet, sampleAnswers } from "../answers-sample.ts";
import { positiveNumber, requireOption, writeOut } from "../cli.ts";

export const SAMPLE_ANSWERS_HELP = `  sample-answers           Take a sample of answered postings to be labelled by hand.
    --store <path>           Store to read (required)
    --out <dir>              Where to write the sheet, the guide, and the predictions (required)
    --size <n>               How many postings to sample (default: 150)
`;

/** As many as a person can label in a sitting or two, matching the location golden set. */
const DEFAULT_SIZE = 150;

/**
 * Writes the three files the accuracy harness needs:
 *
 * - `answers-golden.csv`, a sheet with one empty column per question, to fill in by hand;
 * - `answers-labelling.md`, what each option means;
 * - `answers-predictions.json`, what the model already said.
 *
 * It spends nothing and needs no key: enrichment paid for these answers and the store kept
 * them. The predictions are written separately from the sheet so that labelling is not anchored
 * by them, and so the harness can score without a store or a key, in CI.
 */
export async function sampleAnswersCommand(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      store: { type: "string" },
      out: { type: "string" },
      size: { type: "string" },
    },
    strict: true,
  });
  const storePath = requireOption(values.store, "--store");
  const out = requireOption(values.out, "--out");
  const size = positiveNumber(values.size ?? String(DEFAULT_SIZE), "--size");

  const store = openPipelineStore(storePath);
  try {
    const shapes = answerShapes();
    const sample = sampleAnswers(store.openPostings(), shapes, size);
    if (sample.rows.length === 0) {
      writeOut(
        `No posting holds an answer to every question yet (${sample.considered.toLocaleString("en-US")} considered).\n` +
          "Run `pipeline enrich` first.\n",
      );
      return 1;
    }

    await mkdir(out, { recursive: true });
    await writeFile(join(out, "answers-golden.csv"), renderLabelSheet(sample.rows, shapes));
    await writeFile(join(out, "answers-labelling.md"), renderLabelGuide(shapes));
    await writeFile(
      join(out, "answers-predictions.json"),
      `${JSON.stringify({ questions: shapes, predictions: sample.predictions }, null, 2)}\n`,
    );
    writeOut(
      `Sampled ${sample.rows.length.toLocaleString("en-US")} of ${sample.answered.toLocaleString("en-US")} fully answered postings ` +
        `(${sample.considered.toLocaleString("en-US")} open).\n` +
        `  ${join(out, "answers-golden.csv")} is the sheet to fill in.\n`,
    );
    return 0;
  } finally {
    store.close();
  }
}
