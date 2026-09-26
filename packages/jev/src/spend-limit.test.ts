import { describe, expect, it } from "vitest";
import { JevError } from "./errors.ts";
import { createSpendLimit } from "./spend-limit.ts";

describe("createSpendLimit", () => {
  it("counts initial spend against the limit", () => {
    const limit = createSpendLimit({ limitNanoUsd: 100, initialSpentNanoUsd: 60 });
    expect(() => limit.reserve(41)).toThrow(JevError);
    expect(() => limit.reserve(40)).not.toThrow();
  });

  it("holds reservations until they settle, so concurrent calls cannot overshoot", () => {
    const limit = createSpendLimit({ limitNanoUsd: 100 });
    const first = limit.reserve(60);
    expect(() => limit.reserve(50)).toThrow(/Spend limit of \$0\.000000 reached/);

    first.settle(20);
    expect(limit.spentNanoUsd()).toBe(20);
    expect(limit.reservedNanoUsd()).toBe(0);
    expect(() => limit.reserve(80)).not.toThrow();
  });

  it("reports BUDGET_EXCEEDED as a non-retryable JevError", () => {
    const limit = createSpendLimit({ limitNanoUsd: 0 });
    expect(() => limit.reserve(1)).toThrow(
      expect.objectContaining({ code: "BUDGET_EXCEEDED", retryable: false }),
    );
  });

  it("frees the hold on release and ignores release after settle", () => {
    const limit = createSpendLimit({ limitNanoUsd: 100 });
    const released = limit.reserve(70);
    released.release();
    expect(limit.reservedNanoUsd()).toBe(0);

    const settled = limit.reserve(70);
    settled.settle(10);
    settled.release();
    expect(limit.spentNanoUsd()).toBe(10);
    expect(limit.reservedNanoUsd()).toBe(0);
  });

  it("refuses to settle a closed reservation", () => {
    const reservation = createSpendLimit({ limitNanoUsd: 100 }).reserve(10);
    reservation.release();
    expect(() => reservation.settle(5)).toThrow(/already closed/);
  });

  it.each([-1, 1.5, Number.NaN])("rejects %s as an amount", (amount) => {
    expect(() => createSpendLimit({ limitNanoUsd: amount })).toThrow(RangeError);
    expect(() => createSpendLimit({ limitNanoUsd: 10 }).reserve(amount)).toThrow(RangeError);
  });
});
