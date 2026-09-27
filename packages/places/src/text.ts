/**
 * Folds a name for matching: accents, case, periods, and apostrophes dropped, hyphens read as
 * spaces, whitespace collapsed. "St. Gallen", "St Gallen", and "st-gallen" all fold alike.
 */
export function foldName(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[.'`\u2018\u2019]/g, "")
    .replace(/[\p{Pd}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
