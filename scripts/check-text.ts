/**
 * Fails when a tracked (or new, not ignored) text file contains a forbidden character.
 * Usage: `node scripts/check-text.ts`
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { findTypographyViolations } from "./lib/typography.ts";

const BINARY_SNIFF_BYTES = 8000;

const files = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  {
    encoding: "utf8",
  },
)
  .split("\0")
  .filter((file) => file.length > 0);

let violationCount = 0;
for (const file of files) {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch {
    continue; // Deleted in the working tree but still in the index.
  }
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) continue;

  for (const violation of findTypographyViolations(bytes.toString("utf8"))) {
    console.error(`${file}:${violation.line}:${violation.column} ${violation.message}`);
    violationCount += 1;
  }
}

if (violationCount > 0) {
  console.error(`\n${violationCount} typography violation(s) found.`);
  process.exitCode = 1;
} else {
  console.log(`Checked ${files.length} files: no typography violations.`);
}
