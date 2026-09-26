const EM_DASH = String.fromCodePoint(0x2014);

/** Characters that must not appear in tracked text files, mapped to guidance for authors. */
export const FORBIDDEN_CHARACTERS: ReadonlyMap<string, string> = new Map([
  [EM_DASH, "em dash: use a comma, colon, parentheses, or a separate sentence"],
]);

export interface TypographyViolation {
  /** 1-based line number. */
  readonly line: number;
  /** 1-based column, counted in Unicode code points. */
  readonly column: number;
  readonly character: string;
  readonly message: string;
}

/** Returns every forbidden character in `text`, in reading order. */
export function findTypographyViolations(text: string): TypographyViolation[] {
  const violations: TypographyViolation[] = [];
  const lines = text.split("\n");
  for (const [lineIndex, lineText] of lines.entries()) {
    for (const [columnIndex, character] of Array.from(lineText).entries()) {
      const message = FORBIDDEN_CHARACTERS.get(character);
      if (message !== undefined) {
        violations.push({ line: lineIndex + 1, column: columnIndex + 1, character, message });
      }
    }
  }
  return violations;
}
