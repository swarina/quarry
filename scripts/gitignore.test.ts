import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..");

/**
 * `git check-ignore` exits 0 when the path is ignored and 1 when it is not, so the status is the
 * answer. The path need not exist on disk; only the ignore rules are consulted.
 */
function isIgnored(path: string): boolean {
  const result = spawnSync("git", ["check-ignore", "-q", "--no-index", "--", path], {
    cwd: REPO_ROOT,
  });
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git check-ignore failed for ${path}: ${result.stderr?.toString() ?? ""}`);
  }
  return result.status === 0;
}

describe(".gitignore", () => {
  // check-text.ts scans untracked files so that new prose is checked before it is committed. That
  // only works if generated output is ignored: the export is a dump of crawled posting text and
  // would otherwise fail the typography rules by the tens of thousands.
  it.each([
    "data/criterion-postings.sql",
    "data/pipeline.sqlite",
    "data/index/2026-01-01T00-00-00Z/shards/shard-0.json",
  ])("ignores generated pipeline output at %s", (path) => {
    expect(isIgnored(path)).toBe(true);
  });

  // The ignore rule is anchored to the repository root, so a package's own checked-in data is not
  // caught by it.
  it.each(["packages/places/data/gazetteer.json", "packages/places/data/README.md"])(
    "does not ignore package data at %s",
    (path) => {
      expect(isIgnored(path)).toBe(false);
    },
  );
});
