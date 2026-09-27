import { appendFile, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { openPipelineStore } from "@quarry/storage/node";
import { requireOption, UsageError, writeOut } from "../cli.ts";
import { runIdentity } from "../config.ts";
import { createLogger } from "../log.ts";
import { buildSearchIndex, renderSearchIndexSummary } from "../search.ts";

export const INDEX_HELP = `  index                    Build the search index from the postings boards list now.
    --store <path>           Store to read (required)
    --out <dir>              Directory for manifest.json and the build's shards (required)
    --summary <path>         Append a Markdown summary, for example $GITHUB_STEP_SUMMARY
`;

/** Exit code 1 when the build exceeds a budget; its files are written anyway, to inspect. */
export async function indexCommand(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      store: { type: "string" },
      out: { type: "string" },
      summary: { type: "string" },
    },
    strict: true,
  });
  const storePath = requireOption(values.store, "--store");
  const out = requireOption(values.out, "--out");
  try {
    await stat(storePath);
  } catch {
    throw new UsageError(`${storePath} does not exist`);
  }
  const startedAt = Date.now();
  const identity = runIdentity(startedAt);
  const log = createLogger("pipeline", writeOut);
  const store = openPipelineStore(storePath);
  try {
    const { build, report } = await buildSearchIndex(store, startedAt);
    // Shards first and the manifest last, so a manifest never names a missing shard.
    const [manifest, ...shards] = build.files;
    for (const file of [...shards, ...(manifest === undefined ? [] : [manifest])]) {
      const path = join(out, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.content);
    }
    if (values.summary !== undefined) {
      await appendFile(values.summary, renderSearchIndexSummary(report));
    }
    log.info("search index built", {
      run_id: identity.runId,
      postings: report.postings,
      shards: report.shards.length,
      duration_ms: Date.now() - startedAt,
    });
    for (const problem of report.overBudget)
      log.error("search index over budget", { error_message: problem });
    return report.overBudget.length === 0 ? 0 : 1;
  } finally {
    store.close();
  }
}
