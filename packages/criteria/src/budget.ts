/**
 * What a request is allowed to spend, and what the day is allowed to spend in total.
 *
 * There are two limits because they guard different things. The per-request cap keeps one
 * search from being expensive by accident, and a person can reasonably be told about it. The
 * daily cap is a backstop against this code being wrong: a loop that asks the same postings
 * again, a cache that stopped matching, a criterion id that changes on every request. Those
 * would each be cheap per request and ruinous per day.
 *
 * The daily cap is reserved before spending and settled afterwards, the same shape as the spend
 * limiter inside the Jev client (ADR-0005), and for the same reason: between a check and a
 * charge, other requests are in flight. A Worker has no lock to hold across that gap, so the
 * reservation has to be one atomic step in the store rather than a read followed by a write.
 */

/** A day in UTC, `YYYY-MM-DD`, which is what the daily cap is counted over. */
export type Day = string;

/** The UTC day a moment falls in. UTC so the cap does not shift with the reader's zone. */
export function dayOf(now: number): Day {
  return new Date(now).toISOString().slice(0, 10);
}

export interface BudgetLimits {
  /** The most one request may spend, in nano-dollars. */
  readonly perRequestNanoUsd: number;
  /** The most all requests together may spend in one UTC day. */
  readonly perDayNanoUsd: number;
}

/**
 * Where the day's spend is kept. One method, because the only safe operation is "take up to this
 * much of what is left", which has to happen in a single step.
 */
export interface BudgetStore {
  /**
   * Takes up to `wanted` nano-dollars from `day`'s remaining allowance and returns what it got,
   * which may be 0. Must be atomic against other callers: two requests reserving at once must
   * not both be granted the same allowance.
   */
  reserve(day: Day, wanted: number, perDayNanoUsd: number): Promise<number>;
  /**
   * Returns the part of a reservation that was not spent. Called even when a request fails, so
   * a crash costs the day its reservation only until this runs.
   */
  release(day: Day, unspent: number): Promise<void>;
  /** What has been spent and is still reserved today, for reporting. */
  committed(day: Day): Promise<number>;
}

/** A store in memory, for tests and for a single process. */
export function createMemoryBudgetStore(): BudgetStore {
  const committed = new Map<Day, number>();
  return {
    reserve(day, wanted, perDayNanoUsd) {
      const already = committed.get(day) ?? 0;
      // Granting less than asked is normal near the cap, and the caller reports it.
      const granted = Math.max(0, Math.min(wanted, perDayNanoUsd - already));
      committed.set(day, already + granted);
      return Promise.resolve(granted);
    },
    release(day, unspent) {
      const already = committed.get(day) ?? 0;
      committed.set(day, Math.max(0, already - Math.max(0, unspent)));
      return Promise.resolve();
    },
    committed(day) {
      return Promise.resolve(committed.get(day) ?? 0);
    },
  };
}

export interface Allowance {
  readonly day: Day;
  /** What this request may spend. 0 means the day is spent. */
  readonly nanoUsd: number;
  /** What the per-request cap would have allowed, for explaining a short allowance. */
  readonly perRequestNanoUsd: number;
  /** True when the day's cap, not the per-request cap, is what limited this. */
  readonly limitedByDay: boolean;
}

/**
 * Reserves this request's allowance: the per-request cap, or whatever is left of the day,
 * whichever is smaller.
 */
export async function reserveAllowance(
  store: BudgetStore,
  limits: BudgetLimits,
  now: number,
): Promise<Allowance> {
  const day = dayOf(now);
  const granted = await store.reserve(day, limits.perRequestNanoUsd, limits.perDayNanoUsd);
  return {
    day,
    nanoUsd: granted,
    perRequestNanoUsd: limits.perRequestNanoUsd,
    limitedByDay: granted < limits.perRequestNanoUsd,
  };
}

/** Gives back whatever the request did not spend. */
export async function settleAllowance(
  store: BudgetStore,
  allowance: Allowance,
  spentNanoUsd: number,
): Promise<void> {
  const unspent = allowance.nanoUsd - Math.max(0, spentNanoUsd);
  if (unspent > 0) await store.release(allowance.day, unspent);
}
