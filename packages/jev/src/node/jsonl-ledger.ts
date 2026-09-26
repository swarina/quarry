import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type Ledger, type LedgerEntry, ledgerEntrySchema } from "../ledger.ts";

export interface JsonlLedger extends Ledger {
  /** Every entry recorded so far, oldest first. */
  readEntries(): Promise<LedgerEntry[]>;
  totalCostNanoUsd(): Promise<number>;
}

/**
 * A ledger that appends one JSON object per line to `path`. Appends are serialized, so
 * entries stay complete and in order even when many requests finish at once.
 */
export function createJsonlLedger(path: string): JsonlLedger {
  let pending: Promise<void> = Promise.resolve();

  async function readEntries(): Promise<LedgerEntry[]> {
    await pending;
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    return text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => ledgerEntrySchema.parse(JSON.parse(line)));
  }

  return {
    async record(entry) {
      const line = `${JSON.stringify(ledgerEntrySchema.parse(entry))}\n`;
      const write = pending.then(async () => {
        await mkdir(dirname(path), { recursive: true });
        await appendFile(path, line, "utf8");
      });
      // Keep the queue alive after a failed write; the caller still sees the failure below.
      pending = write.catch(() => undefined);
      await write;
    },
    readEntries,
    async totalCostNanoUsd() {
      const entries = await readEntries();
      return entries.reduce((total, entry) => total + entry.costNanoUsd, 0);
    },
  };
}
