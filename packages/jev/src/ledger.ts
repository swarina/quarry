import { z } from "zod";
import { JEV_ERROR_CODES } from "./errors.ts";

/** One Jev request, successful or not. The ledger is the source of truth for spend. */
export const ledgerEntrySchema = z.object({
  /** Epoch milliseconds when the request was sent. */
  at: z.int().nonnegative(),
  /** Short label for what the request was for, for example "enrichment" or "criterion". */
  purpose: z.string().min(1),
  model: z.string().min(1),
  status: z.enum(["ok", "error"]),
  errorCode: z.enum(JEV_ERROR_CODES).optional(),
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  costNanoUsd: z.int().nonnegative(),
  latencyMs: z.number().nonnegative(),
  requestId: z.string().optional(),
});

export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;

export interface Ledger {
  record(entry: LedgerEntry): Promise<void>;
}

export interface MemoryLedger extends Ledger {
  readonly entries: readonly LedgerEntry[];
  totalCostNanoUsd(): number;
}

/** An in-process ledger, for tests and short-lived scripts. */
export function createMemoryLedger(): MemoryLedger {
  const entries: LedgerEntry[] = [];
  return {
    entries,
    record(entry) {
      entries.push(entry);
      return Promise.resolve();
    },
    totalCostNanoUsd: () => entries.reduce((total, entry) => total + entry.costNanoUsd, 0),
  };
}
