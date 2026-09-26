/**
 * The Jev model version every request is pinned to.
 *
 * Aliases such as `jev-latest` move whenever TypeSafe ships a release, which would silently
 * change answers, invalidate cached results, and void thresholds tuned on labeled data.
 * Upgrading is a deliberate change: evaluate the new version first, then update this value.
 */
export const JEV_MODEL = "jev-1.13.0";

/**
 * Input price in nano-dollars per token: $0.042 per million input tokens, and output tokens
 * are free. Nano-dollars keep every cost calculation in exact integers.
 * Source: https://docs.typesafe.ai/models (checked 2026-09-26).
 */
export const INPUT_PRICE_NANO_USD_PER_TOKEN = 42;

/** Documented request limits for jev-1.13 (https://docs.typesafe.ai/models, checked 2026-09-26). */
export const JEV_LIMITS = {
  maxChoiceOptions: 255,
  minScoreLevels: 2,
  maxScoreLevels: 10,
  requestsPerMinute: 1200,
} as const;

/** Cost of a request in nano-dollars, from the input token count the API reports. */
export function costNanoUsd(inputTokens: number): number {
  return inputTokens * INPUT_PRICE_NANO_USD_PER_TOKEN;
}

/** Formats nano-dollars as US dollars for logs and reports, for example `$0.000042`. */
export function formatUsd(nanoUsd: number): string {
  return `$${(nanoUsd / 1e9).toFixed(6)}`;
}
