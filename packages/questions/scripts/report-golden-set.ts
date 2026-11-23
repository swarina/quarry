/**
 * Says whether the standard questions' accuracy set can be scored, as a Markdown section, and
 * exits non-zero when it cannot.
 *
 * This is what keeps the gap visible. `golden.test.ts` skips an unlabelled set so that an
 * ordinary test run passes, which on its own leaves nothing to tell "the accuracy check passed"
 * from "the accuracy check did not happen". CI runs this and writes the answer into the run
 * summary, where the absence is a warning rather than a silence.
 *
 * It reads only the two fixture files, so it needs no store, no key, and no network.
 *
 * Usage: pnpm --filter @quarry/questions report-golden-set
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { goldenSetStatus, MINIMUM_LABELS } from "../src/golden-set.ts";
import { answerShapes } from "../src/index.ts";

const FIXTURES = join(dirname(dirname(fileURLToPath(import.meta.url))), "fixtures");
const LABELS = join(FIXTURES, "answers-golden.csv");
const PREDICTIONS = join(FIXTURES, "answers-predictions.json");

const shapes = answerShapes();
const status = goldenSetStatus({
  questions: shapes,
  sheet: existsSync(LABELS) ? readFileSync(LABELS, "utf8") : null,
  hasPredictions: existsSync(PREDICTIONS),
});

const lines = [
  "### Standard question accuracy",
  "",
  status.complete
    ? `Measured: every question has ${MINIMUM_LABELS} or more hand-written labels, and \`golden.test.ts\` scored them.`
    : `Not measured: \`golden.test.ts\` skipped the questions it cannot score. ${status.reason}`,
  "",
  "| Question | Labels | Scored |",
  "| --- | ---: | --- |",
];
for (const shape of shapes) {
  const count = status.labelled[shape.id] ?? 0;
  lines.push(`| ${shape.id} | ${count} | ${count >= MINIMUM_LABELS ? "yes" : "no"} |`);
}
if (!status.complete) {
  lines.push(
    "",
    "Fill in `packages/questions/fixtures/answers-golden.csv` by hand, following",
    "`answers-labelling.md` beside it. Once every question is labelled, set",
    "`QUARRY_REQUIRE_GOLDEN=1` on the test step so that a set going missing fails the build.",
  );
}
process.stdout.write(`${lines.join("\n")}\n`);
if (!status.complete) process.exitCode = 1;
