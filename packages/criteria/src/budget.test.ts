import { describe, expect, it } from "vitest";
import { createMemoryBudgetStore, dayOf, reserveAllowance, settleAllowance } from "./budget.ts";

const CENT = 10_000_000;
const LIMITS = { perRequestNanoUsd: CENT, perDayNanoUsd: 5 * CENT };
const NOON = Date.UTC(2026, 9, 6, 12, 0, 0);

describe("the day a moment falls in", () => {
  it("is the UTC date, so the cap does not shift with the reader's zone", () => {
    expect(dayOf(Date.UTC(2026, 9, 6, 12))).toBe("2026-10-06");
    // Just before and just after midnight UTC are different days, wherever the reader is.
    expect(dayOf(Date.UTC(2026, 9, 6, 23, 59, 59))).toBe("2026-10-06");
    expect(dayOf(Date.UTC(2026, 9, 7, 0, 0, 0))).toBe("2026-10-07");
  });
});

describe("reserving an allowance", () => {
  it("gives a request the per-request cap while the day has room", async () => {
    const store = createMemoryBudgetStore();
    const allowance = await reserveAllowance(store, LIMITS, NOON);
    expect(allowance).toMatchObject({
      day: "2026-10-06",
      nanoUsd: CENT,
      limitedByDay: false,
    });
  });

  it("takes the reservation out of the day immediately, before anything is spent", async () => {
    const store = createMemoryBudgetStore();
    await reserveAllowance(store, LIMITS, NOON);
    // Committed, not spent: between a check and a charge other requests are in flight, so the
    // allowance has to be held from the moment it is granted.
    expect(await store.committed("2026-10-06")).toBe(CENT);
  });

  it("gives out only what the day has left, and says the day was the limit", async () => {
    const store = createMemoryBudgetStore();
    // Four full allowances of a five-allowance day.
    for (let at = 0; at < 4; at += 1) await reserveAllowance(store, LIMITS, NOON);
    const fifth = await reserveAllowance(store, { ...LIMITS, perDayNanoUsd: 4 * CENT + 500 }, NOON);
    expect(fifth.nanoUsd).toBe(500);
    expect(fifth.limitedByDay).toBe(true);
  });

  it("gives nothing once the day is spent", async () => {
    const store = createMemoryBudgetStore();
    for (let at = 0; at < 5; at += 1) await reserveAllowance(store, LIMITS, NOON);
    const over = await reserveAllowance(store, LIMITS, NOON);
    expect(over.nanoUsd).toBe(0);
  });

  it("never grants more than the day allows, however many ask at once", async () => {
    const store = createMemoryBudgetStore();
    const together = await Promise.all(
      Array.from({ length: 20 }, () => reserveAllowance(store, LIMITS, NOON)),
    );
    const granted = together.reduce((total, allowance) => total + allowance.nanoUsd, 0);
    // The whole point of reserving in one step: twenty at once cannot each pass the same check.
    expect(granted).toBe(LIMITS.perDayNanoUsd);
    expect(await store.committed("2026-10-06")).toBe(LIMITS.perDayNanoUsd);
  });

  it("counts each day on its own", async () => {
    const store = createMemoryBudgetStore();
    for (let at = 0; at < 5; at += 1) await reserveAllowance(store, LIMITS, NOON);
    const tomorrow = await reserveAllowance(store, LIMITS, NOON + 24 * 60 * 60 * 1000);
    expect(tomorrow.nanoUsd).toBe(CENT);
    expect(tomorrow.day).toBe("2026-10-07");
  });
});

describe("settling an allowance", () => {
  it("gives back what was not spent, so the day is charged what it cost", async () => {
    const store = createMemoryBudgetStore();
    const allowance = await reserveAllowance(store, LIMITS, NOON);
    await settleAllowance(store, allowance, 1_234);
    expect(await store.committed("2026-10-06")).toBe(1_234);
  });

  it("gives the whole reservation back when nothing was spent", async () => {
    const store = createMemoryBudgetStore();
    const allowance = await reserveAllowance(store, LIMITS, NOON);
    await settleAllowance(store, allowance, 0);
    expect(await store.committed("2026-10-06")).toBe(0);
  });

  it("keeps the whole reservation when it was all spent", async () => {
    const store = createMemoryBudgetStore();
    const allowance = await reserveAllowance(store, LIMITS, NOON);
    await settleAllowance(store, allowance, CENT);
    expect(await store.committed("2026-10-06")).toBe(CENT);
  });

  it("does not credit the day when more was spent than reserved", async () => {
    const store = createMemoryBudgetStore();
    const allowance = await reserveAllowance(store, LIMITS, NOON);
    // An overshoot should never hand the day back budget it did not have.
    await settleAllowance(store, allowance, CENT * 2);
    expect(await store.committed("2026-10-06")).toBe(CENT);
  });

  it("frees the day again across many reserve-and-settle rounds", async () => {
    const store = createMemoryBudgetStore();
    for (let at = 0; at < 50; at += 1) {
      const allowance = await reserveAllowance(store, LIMITS, NOON);
      expect(allowance.nanoUsd).toBeGreaterThan(0);
      await settleAllowance(store, allowance, 100);
    }
    // Fifty cheap requests cost fifty times their cost, not fifty allowances.
    expect(await store.committed("2026-10-06")).toBe(50 * 100);
  });
});
