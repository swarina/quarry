import type { AtsSource } from "@quarry/domain";
import type { FreshnessSample } from "@quarry/storage/node";

const HOUR_MS = 60 * 60 * 1000;

/** Besides each run on its own, freshness is reported over this many trailing days. */
export const FRESHNESS_WINDOW_DAYS = 7;
export const FRESHNESS_WINDOW_MS = FRESHNESS_WINDOW_DAYS * 24 * HOUR_MS;

/** How long after publication a set of new postings was first seen. */
export interface FreshnessStats {
  /** Postings first seen on a board we had listed before. */
  readonly postings: number;
  /** Of those, the ones whose ATS states a publish time. */
  readonly timed: number;
  /** Nearest-rank percentiles of first sighting minus publish time, in hours; null when none is timed. */
  readonly p50Hours: number | null;
  readonly p95Hours: number | null;
}

export interface Freshness {
  readonly windowDays: number;
  /** Postings this run saw first. */
  readonly run: FreshnessStats;
  /** Postings first seen in the trailing window, this run included. */
  readonly window: FreshnessStats;
  /** The window per source, because ATSs differ in what their publish time means. */
  readonly bySource: Readonly<Partial<Record<AtsSource, FreshnessStats>>>;
}

/** Summarizes the window's samples, and the ones first seen by run `runId`. */
export function summarizeFreshness(samples: readonly FreshnessSample[], runId: string): Freshness {
  const sources = [...new Set(samples.map((sample) => sample.source))].sort();
  return {
    windowDays: FRESHNESS_WINDOW_DAYS,
    run: freshnessStats(samples.filter((sample) => sample.runId === runId)),
    window: freshnessStats(samples),
    bySource: Object.fromEntries(
      sources.map((source) => [
        source,
        freshnessStats(samples.filter((sample) => sample.source === source)),
      ]),
    ),
  };
}

export function freshnessStats(samples: readonly FreshnessSample[]): FreshnessStats {
  // A publish time a little ahead of our clock means the posting was seen straight away.
  const latencies = samples
    .flatMap((sample) => (sample.latencyMs === null ? [] : [Math.max(0, sample.latencyMs)]))
    .sort((left, right) => left - right);
  return {
    postings: samples.length,
    timed: latencies.length,
    p50Hours: hours(percentile(latencies, 0.5)),
    p95Hours: hours(percentile(latencies, 0.95)),
  };
}

/**
 * The nearest-rank percentile of `sorted` (ascending): the smallest value with at least
 * `fraction` of the values at or below it. Undefined for an empty list.
 */
export function percentile(sorted: readonly number[], fraction: number): number | undefined {
  if (sorted.length === 0) return undefined;
  return sorted[Math.max(1, Math.ceil(fraction * sorted.length)) - 1];
}

function hours(ms: number | undefined): number | null {
  return ms === undefined ? null : Math.round((ms / HOUR_MS) * 10) / 10;
}
