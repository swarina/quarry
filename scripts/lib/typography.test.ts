import { describe, expect, it } from "vitest";
import { findTypographyViolations } from "./typography.ts";

const EM_DASH = String.fromCodePoint(0x2014);
const EN_DASH = String.fromCodePoint(0x2013);
const EMOJI = String.fromCodePoint(0x1f600);

describe("findTypographyViolations", () => {
  it("returns nothing for clean text", () => {
    const text = "Plain text, with commas: and colons (and parentheses).";
    expect(findTypographyViolations(text)).toEqual([]);
  });

  it("reports the line and code point column of each em dash", () => {
    const text = `first line\nsecond ${EM_DASH} line\n${EM_DASH}`;
    const violations = findTypographyViolations(text);
    expect(violations.map(({ line, column }) => ({ line, column }))).toEqual([
      { line: 2, column: 8 },
      { line: 3, column: 1 },
    ]);
    expect(violations[0]?.message).toMatch(/em dash/);
  });

  it("counts columns in code points, not UTF-16 units", () => {
    expect(findTypographyViolations(`${EMOJI}${EM_DASH}`)[0]?.column).toBe(2);
  });

  it("allows hyphens and en dashes", () => {
    expect(findTypographyViolations(`well-known 1${EN_DASH}2`)).toEqual([]);
  });
});
