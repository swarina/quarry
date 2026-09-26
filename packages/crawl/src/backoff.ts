/**
 * Milliseconds to wait before retry number `retry` (1 for the first retry): exponential backoff
 * with full jitter, `random() * min(cap, base * 2^(retry - 1))`, which spreads retries from
 * many clients instead of synchronizing them.
 */
export function backoffDelay(
  retry: number,
  baseMs: number,
  capMs: number,
  random: () => number,
): number {
  return Math.floor(random() * Math.min(capMs, baseMs * 2 ** (retry - 1)));
}

/**
 * Milliseconds until the time a `Retry-After` header asks for, given as delay-seconds or as an
 * HTTP date. Returns undefined when the header is missing or malformed.
 */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  // Every HTTP date format starts with a day name; Date.parse alone accepts almost anything.
  if (!/^[A-Za-z]{3,9},? /.test(trimmed)) return undefined;
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}
