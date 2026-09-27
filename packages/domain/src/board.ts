/**
 * - `active`: crawled on every run.
 * - `retired`: removed from the seed list; kept for history, not crawled.
 * - `gone`: the ATS kept answering 404; its open postings close (ADR-0016).
 * - `denied`: on the removal list; its data is deleted and it is never crawled.
 */
export const BOARD_STATUSES = ["active", "retired", "gone", "denied"] as const;

export type BoardStatus = (typeof BOARD_STATUSES)[number];

/** Consecutive 404s after which a board is declared gone (ADR-0016). */
export const BOARD_GONE_AFTER_NOT_FOUND = 3;

/** The 404s must also span at least this long, so one bad hour can't retire a board. */
export const BOARD_GONE_MIN_SPAN_MS = 48 * 60 * 60 * 1000;

/**
 * Whether a board that has answered 404 `notFoundCount` times in a row, the first at
 * `firstNotFoundAt`, should now be declared gone.
 */
export function isBoardGone(notFoundCount: number, firstNotFoundAt: number, now: number): boolean {
  return (
    notFoundCount >= BOARD_GONE_AFTER_NOT_FOUND && now - firstNotFoundAt >= BOARD_GONE_MIN_SPAN_MS
  );
}
