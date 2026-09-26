import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LedgerEntry } from "../ledger.ts";
import { createJsonlLedger } from "./jsonl-ledger.ts";

function entry(costNanoUsd: number, purpose = "test"): LedgerEntry {
  return {
    at: 1_700_000_000_000,
    purpose,
    model: "jev-1.13.0",
    status: "ok",
    inputTokens: costNanoUsd / 42,
    outputTokens: 1,
    costNanoUsd,
    latencyMs: 120,
  };
}

describe("createJsonlLedger", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "quarry-ledger-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("appends one JSON line per entry and reads them back in order", async () => {
    const path = join(directory, "runs", "ledger.jsonl");
    const ledger = createJsonlLedger(path);
    await Promise.all([ledger.record(entry(42, "a")), ledger.record(entry(84, "b"))]);

    const lines = (await readFile(path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect((await ledger.readEntries()).map((e) => e.purpose)).toEqual(["a", "b"]);
    expect(await ledger.totalCostNanoUsd()).toBe(126);
  });

  it("treats a missing file as an empty ledger", async () => {
    const ledger = createJsonlLedger(join(directory, "none.jsonl"));
    expect(await ledger.readEntries()).toEqual([]);
    expect(await ledger.totalCostNanoUsd()).toBe(0);
  });

  it("refuses to record an invalid entry", async () => {
    const ledger = createJsonlLedger(join(directory, "ledger.jsonl"));
    await expect(ledger.record({ ...entry(42), costNanoUsd: -1 })).rejects.toThrow();
    expect(await ledger.readEntries()).toEqual([]);
  });
});
