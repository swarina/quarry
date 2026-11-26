/**
 * A per-caller gate in front of the criterion routes.
 *
 * Both routes read D1 on every call, and `/criteria/estimate` reserves no spend allowance,
 * correctly, because estimating calls no model. So knowing the shared secret was the only thing
 * standing between a caller and an unbounded number of reads against the free plan's daily quota,
 * and exhausting it takes down `/criteria/ask` as well, which reads the same tables.
 *
 * This is a counter in the isolate rather than Cloudflare's `ratelimit` binding, which the
 * Worker could also use. The binding's own guarantee is approximate: the docs say a rate limit
 * "defined and enforced in your Worker" is local to the Cloudflare location the Worker runs in,
 * that counts are eventually consistent, and that two checks in one location can both allow a
 * request before their counts synchronize. So the binding is tighter than this counter (it is
 * shared by the isolates in a location, where this is not) but it is not a global limit either,
 * and it exists only once a deploy configures it, which puts it outside anything the repository
 * can test. A counter here is weaker in exactly one way, is verifiable in CI, and can be swapped
 * for the binding when there is a deployment to measure it against.
 *
 * Neither bounds a caller who can spread requests across addresses, and the Cloudflare docs warn
 * that an address can be shared by many legitimate users, so the limit is set for what a person
 * asking questions about a page of results needs and no tighter. What makes the quota hard to
 * exhaust is the cost of a request, not the rate: see the posting lookup in `d1.ts`.
 */

/**
 * Requests per minute per caller.
 *
 * Sized for legitimate use, not to bound the daily quota: a person asking about a page of results
 * sends an estimate and then an ask, so one request per second is far above anything a browser
 * does and far below a loop. A per-minute limit cannot bound a daily budget on its own, whatever
 * its value, because a day holds 1,440 minutes of it.
 */
export const REQUESTS_PER_MINUTE = 60;

/** The window the limit is counted over. */
const WINDOW_MS = 60_000;

/**
 * Callers tracked within one window. Past this the table is full and further new callers are
 * turned away for the rest of the window: that costs an unlucky caller under a minute, where
 * letting them through uncounted would cost the day's reads.
 */
const MAX_CALLERS = 10_000;

export interface RateLimitGate {
  /** Charges one request to `key`, and says whether it may proceed. */
  allow(key: string): boolean;
}

export interface RateLimitOptions {
  readonly requestsPerWindow?: number;
  readonly windowMs?: number;
  readonly maxCallers?: number;
  /** Clock in milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * A fixed-window counter per caller.
 *
 * Fixed rather than sliding so the whole table is dropped when the window turns, which bounds
 * memory without sweeping and without a per-caller timer. The cost is the usual one: a caller
 * that straddles a boundary can send up to twice the limit across the two adjacent windows.
 */
export function createRateLimitGate(options: RateLimitOptions = {}): RateLimitGate {
  const limit = options.requestsPerWindow ?? REQUESTS_PER_MINUTE;
  const windowMs = options.windowMs ?? WINDOW_MS;
  const maxCallers = options.maxCallers ?? MAX_CALLERS;
  const now = options.now ?? Date.now;

  let windowAt = Number.NaN;
  let used = new Map<string, number>();

  return {
    allow(key) {
      const at = Math.floor(now() / windowMs);
      if (at !== windowAt) {
        windowAt = at;
        used = new Map();
      }
      const already = used.get(key);
      if (already === undefined && used.size >= maxCallers) return false;
      const count = (already ?? 0) + 1;
      used.set(key, count);
      return count <= limit;
    },
  };
}

/**
 * The caller a request is charged to.
 *
 * `CF-Connecting-IP` is set by Cloudflare on every request that reaches a Worker, and a client
 * cannot forge it. Off Cloudflare, under `wrangler dev` or a Node test, it may be missing; one
 * shared bucket is the safe reading of "no caller identified".
 */
export function callerOf(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unidentified";
}

function tooMany(windowMs: number): Response {
  return new Response(
    `${JSON.stringify({
      error: { code: "RATE_LIMITED", message: "too many requests; try again shortly" },
    })}\n`,
    {
      status: 429,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "retry-after": String(Math.ceil(windowMs / 1000)),
      },
    },
  );
}

/**
 * Runs `handle` unless the caller is over the limit, in which case nothing else runs.
 *
 * Written as a wrapper rather than a check inside `createCriteriaHandler` so the handler stays
 * the plain `(Request) => Response` a Node test can drive, and so what runs before the first D1
 * read is one call a test can watch.
 */
export async function underRateLimit(
  request: Request,
  gate: RateLimitGate,
  handle: () => Promise<Response>,
  windowMs = WINDOW_MS,
): Promise<Response> {
  if (!gate.allow(callerOf(request))) return tooMany(windowMs);
  return handle();
}
