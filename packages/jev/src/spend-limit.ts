import { JevError } from "./errors.ts";
import { formatUsd } from "./model.ts";

/**
 * A hard cap on Jev spend. Each request reserves an upper bound on its cost before it is sent
 * and settles to the actual cost afterwards, so concurrent requests can never overshoot the cap.
 */
export interface SpendLimit {
  readonly limitNanoUsd: number;
  /** Nano-dollars settled so far, including any initial spend. */
  spentNanoUsd(): number;
  /** Nano-dollars held by reservations that have not settled yet. */
  reservedNanoUsd(): number;
  /** Holds `amountNanoUsd`; throws a `BUDGET_EXCEEDED` JevError if it does not fit. */
  reserve(amountNanoUsd: number): SpendReservation;
}

export interface SpendReservation {
  /** Records the actual cost and frees the rest of the hold. */
  settle(actualNanoUsd: number): void;
  /** Frees the hold without spending anything. Has no effect once settled. */
  release(): void;
}

export interface SpendLimitOptions {
  readonly limitNanoUsd: number;
  /** Spend already incurred in this budget period, for example read from a ledger. */
  readonly initialSpentNanoUsd?: number;
}

export function createSpendLimit(options: SpendLimitOptions): SpendLimit {
  const limit = nonNegativeInteger("limitNanoUsd", options.limitNanoUsd);
  let spent = nonNegativeInteger("initialSpentNanoUsd", options.initialSpentNanoUsd ?? 0);
  let reserved = 0;

  return {
    limitNanoUsd: limit,
    spentNanoUsd: () => spent,
    reservedNanoUsd: () => reserved,
    reserve(amountNanoUsd) {
      const amount = nonNegativeInteger("amountNanoUsd", amountNanoUsd);
      if (spent + reserved + amount > limit) {
        throw new JevError(
          "BUDGET_EXCEEDED",
          `Spend limit of ${formatUsd(limit)} reached (${formatUsd(spent)} spent, ` +
            `${formatUsd(reserved)} reserved, ${formatUsd(amount)} requested)`,
        );
      }
      reserved += amount;

      let open = true;
      return {
        settle(actualNanoUsd) {
          if (!open) throw new Error("This spend reservation is already closed");
          const actual = nonNegativeInteger("actualNanoUsd", actualNanoUsd);
          open = false;
          reserved -= amount;
          spent += actual;
        },
        release() {
          if (!open) return;
          open = false;
          reserved -= amount;
        },
      };
    },
  };
}

function nonNegativeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer, got ${value}`);
  }
  return value;
}
