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

/**
 * How many of a board's most recent full listings a posting may be missing from and still count
 * as open.
 *
 * Only a full listing is evidence of absence. A 304 says the listing is unchanged, and a failed
 * or not-found crawl says nothing about any particular posting, so neither can close one.
 *
 * At 1 this is "in the latest listing", which is what the search index used to mean by current,
 * and it makes one short or partial listing drop a live job out of search until the next run. At
 * 2 a posting survives one such listing, and a job that really closed leaves search one crawl
 * later than it could have. That is the trade: a day of a closed job showing, against a day of a
 * live job hidden. Hiding live jobs is the worse failure for someone searching, and a wrongly
 * shown job is visibly closed the moment they open it.
 */
export const POSTING_OPEN_WITHIN_LISTINGS = 2;
