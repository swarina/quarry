import { fc, test } from "@fast-check/vitest";
import type { FreshnessSample } from "@quarry/storage/node";
import { describe, expect, it } from "vitest";
import { freshnessStats, percentile, summarizeFreshness } from "./freshness.ts";

const HOUR = 60 * 60 * 1000;

function sample(
  latencyHours: number | null,
  overrides: Partial<FreshnessSample> = {},
): FreshnessSample {
  return {
    runId: "gh-2-1",
    source: "greenhouse",
    latencyMs: latencyHours === null ? null : latencyHours * HOUR,
    ...overrides,
  };
}

describe("percentile", () => {
  it("uses the nearest rank", () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(values, 0.5)).toBe(5);
    expect(percentile(values, 0.95)).toBe(10);
    expect(percentile(values, 0.1)).toBe(1);
    expect(percentile([7], 0.95)).toBe(7);
    expect(percentile([], 0.5)).toBeUndefined();
  });

  test.prop([
    fc.array(fc.integer({ min: 0, max: 10_000_000 }), { minLength: 1, maxLength: 200 }),
    fc.double({ min: 0, max: 1, noNaN: true }),
    fc.double({ min: 0, max: 1, noNaN: true }),
  ])("is a value from the list, and never decreases as the fraction grows", (values, a, b) => {
    const sorted = [...values].sort((left, right) => left - right);
    const [low, high] = a <= b ? [a, b] : [b, a];
    const lowValue = percentile(sorted, low);
    const highValue = percentile(sorted, high);
    expect(sorted).toContain(lowValue);
    expect(lowValue).toBeLessThanOrEqual(highValue ?? Number.NaN);
    const atOrBelow = sorted.filter((value) => value <= (highValue ?? Number.NaN)).length;
    expect(atOrBelow / sorted.length).toBeGreaterThanOrEqual(high);
  });
});

describe("freshnessStats", () => {
  it("reports hours to one decimal, counting postings without a publish time apart", () => {
    const stats = freshnessStats([
      sample(2),
      sample(30.04),
      sample(null),
      sample(10),
      sample(47.96),
    ]);
    expect(stats).toEqual({ postings: 5, timed: 4, p50Hours: 10, p95Hours: 48 });
  });

  it("treats a publish time ahead of our clock as no delay", () => {
    expect(freshnessStats([sample(-0.5), sample(-0.1)])).toMatchObject({
      p50Hours: 0,
      p95Hours: 0,
    });
  });

  it("has no percentiles without a timed posting", () => {
    expect(freshnessStats([])).toEqual({ postings: 0, timed: 0, p50Hours: null, p95Hours: null });
    expect(freshnessStats([sample(null)])).toEqual({
      postings: 1,
      timed: 0,
      p50Hours: null,
      p95Hours: null,
    });
  });
});

describe("summarizeFreshness", () => {
  it("splits the window into this run and each source", () => {
    const freshness = summarizeFreshness(
      [
        sample(20, { runId: "gh-1-1" }),
        sample(4, { runId: "gh-2-1", source: "lever" }),
        sample(6, { runId: "gh-2-1", source: "ashby" }),
        sample(30, { runId: "gh-1-1", source: "lever" }),
      ],
      "gh-2-1",
    );
    expect(freshness.windowDays).toBe(7);
    expect(freshness.run).toEqual({ postings: 2, timed: 2, p50Hours: 4, p95Hours: 6 });
    expect(freshness.window).toEqual({ postings: 4, timed: 4, p50Hours: 6, p95Hours: 30 });
    expect(Object.keys(freshness.bySource)).toEqual(["ashby", "greenhouse", "lever"]);
    expect(freshness.bySource.lever).toEqual({ postings: 2, timed: 2, p50Hours: 4, p95Hours: 30 });
  });
});
