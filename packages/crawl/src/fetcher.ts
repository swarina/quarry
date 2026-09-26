import { backoffDelay, parseRetryAfter } from "./backoff.ts";
import { ALLOW_ALL, parseRobots, ROBOTS_MAX_BYTES, type RobotsPolicy } from "./robots.ts";

export type FetchFailure =
  | "timeout"
  | "network"
  | "rate-limited"
  | "server-error"
  | "http-error"
  | "redirect"
  | "too-large"
  | "retry-after-too-long";

export type FetchOutcome =
  | {
      readonly kind: "ok";
      readonly status: number;
      readonly body: string;
      readonly etag: string | null;
      readonly bytes: number;
      readonly attempts: number;
    }
  | { readonly kind: "not-modified"; readonly attempts: number }
  | { readonly kind: "not-found"; readonly status: number; readonly attempts: number }
  | {
      readonly kind: "failed";
      readonly failure: FetchFailure;
      readonly status: number | null;
      readonly message: string;
      readonly attempts: number;
    }
  | {
      readonly kind: "skipped";
      readonly reason: "disallowed" | "robots-unreachable" | "circuit-open";
    };

export interface HostStats {
  /** HTTP requests sent, including retries and robots.txt. */
  readonly requests: number;
  readonly retries: number;
  readonly failures: number;
  readonly bytes: number;
  readonly circuitOpen: boolean;
  readonly robots: "pending" | "allowed-all" | "parsed" | "unreachable";
  readonly crawlDelaySeconds: number | undefined;
}

export interface PoliteFetcherOptions {
  /** Full User-Agent header, for example `QuarryBot/1.0 (+https://example.com/sources)`. */
  readonly userAgent: string;
  /** The token robots.txt groups are matched against, for example `QuarryBot`. */
  readonly productToken: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  /** Minimum gap between the end of one request to a host and the start of the next. */
  readonly minGapMs?: number;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly maxRetries?: number;
  readonly backoffBaseMs?: number;
  readonly backoffCapMs?: number;
  /** A longer `Retry-After` fails the request instead of blocking the host. */
  readonly maxRetryAfterMs?: number;
  /** Consecutive failed requests after which a host is skipped for the rest of the run. */
  readonly breakerThreshold?: number;
}

export interface GetOptions {
  /** Sent as `If-None-Match`; a 304 then comes back as `not-modified`. */
  readonly etag?: string | null;
  /** Aborting rejects the call with the signal's reason; it is not reported as a failure. */
  readonly signal?: AbortSignal;
}

export interface PoliteFetcher {
  get(url: string, options?: GetOptions): Promise<FetchOutcome>;
  stats(): ReadonlyMap<string, HostStats>;
}

interface HostState {
  queue: Promise<unknown>;
  nextRequestAt: number;
  robots: Promise<RobotsPolicy | "unreachable"> | undefined;
  robotsState: HostStats["robots"];
  crawlDelaySeconds: number | undefined;
  consecutiveFailures: number;
  requests: number;
  retries: number;
  failures: number;
  bytes: number;
}

/** A finished HTTP exchange. The body is read only for 2xx responses. */
type Attempt =
  | {
      readonly kind: "response";
      readonly status: number;
      readonly headers: Headers;
      readonly body: string;
      readonly bytes: number;
      readonly tooLarge: boolean;
    }
  | { readonly kind: "error"; readonly failure: "timeout" | "network"; readonly message: string };

interface BodyLimit {
  readonly maxBytes: number;
  /** Keep the first `maxBytes` instead of reporting the body as too large. */
  readonly truncate: boolean;
}

/** Failures that say something about the host rather than one board. */
const HOST_FAILURES: ReadonlySet<FetchFailure> = new Set([
  "timeout",
  "network",
  "rate-limited",
  "server-error",
  "http-error",
  "retry-after-too-long",
]);

/**
 * An HTTP client that is polite by construction (ADR-0018): it checks robots.txt before the
 * first request to a host, sends one request at a time per host with a minimum gap (or the
 * site's crawl delay, if longer), retries transient failures with jittered backoff while
 * honoring `Retry-After`, and stops calling a host after repeated failures.
 */
export function createPoliteFetcher(options: PoliteFetcherOptions): PoliteFetcher {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  const minGapMs = options.minGapMs ?? 1_000;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxBytes = options.maxBytes ?? 50 * 1024 * 1024;
  const maxRetries = options.maxRetries ?? 2;
  const backoffBaseMs = options.backoffBaseMs ?? 2_000;
  const backoffCapMs = options.backoffCapMs ?? 60_000;
  const maxRetryAfterMs = options.maxRetryAfterMs ?? 5 * 60_000;
  const breakerThreshold = options.breakerThreshold ?? 5;
  const hosts = new Map<string, HostState>();

  function hostState(host: string): HostState {
    let state = hosts.get(host);
    if (state === undefined) {
      state = {
        queue: Promise.resolve(),
        nextRequestAt: 0,
        robots: undefined,
        robotsState: "pending",
        crawlDelaySeconds: undefined,
        consecutiveFailures: 0,
        requests: 0,
        retries: 0,
        failures: 0,
        bytes: 0,
      };
      hosts.set(host, state);
    }
    return state;
  }

  /** Runs `task` after every earlier task for the same host has finished. */
  function exclusive<T>(state: HostState, task: () => Promise<T>): Promise<T> {
    const result = state.queue.then(task);
    state.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** One request, headers and body, under the host's pacing and the request timeout. */
  async function send(
    state: HostState,
    url: string,
    init: RequestInit,
    limit: BodyLimit,
    signal: AbortSignal | undefined,
  ): Promise<Attempt> {
    const wait = state.nextRequestAt - now();
    if (wait > 0) await sleep(wait);
    signal?.throwIfAborted();
    state.requests += 1;
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetchImpl(url, {
        ...init,
        headers: { "user-agent": options.userAgent, ...init.headers },
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return {
          kind: "response",
          status: response.status,
          headers: response.headers,
          body: "",
          bytes: 0,
          tooLarge: false,
        };
      }
      const body = await readBody(response, limit);
      state.bytes += body.bytes;
      return { kind: "response", status: response.status, headers: response.headers, ...body };
    } catch (error) {
      signal?.throwIfAborted();
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      return {
        kind: "error",
        failure: timedOut ? "timeout" : "network",
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      const gapMs = Math.max(minGapMs, (state.crawlDelaySeconds ?? 0) * 1000);
      state.nextRequestAt = now() + gapMs;
    }
  }

  async function loadRobots(
    state: HostState,
    origin: string,
  ): Promise<RobotsPolicy | "unreachable"> {
    const limit = { maxBytes: ROBOTS_MAX_BYTES, truncate: true };
    for (let attempt = 1; ; attempt += 1) {
      const result = await send(
        state,
        `${origin}/robots.txt`,
        { redirect: "follow" },
        limit,
        undefined,
      );
      if (result.kind === "response") {
        const { status } = result;
        if (status >= 200 && status < 300) return parseRobots(result.body, options.productToken);
        // RFC 9309: a 4xx means there are no rules. A 429 is treated like a 5xx: the site is
        // asking us to slow down, which is not a green light.
        if (status >= 400 && status < 500 && status !== 429) return ALLOW_ALL;
      }
      if (attempt > maxRetries) return "unreachable";
      state.retries += 1;
      await sleep(backoffDelay(attempt, backoffBaseMs, backoffCapMs, random));
    }
  }

  function robotsFor(state: HostState, origin: string): Promise<RobotsPolicy | "unreachable"> {
    if (state.robots === undefined) {
      state.robots = exclusive(state, () => loadRobots(state, origin)).then((policy) => {
        state.robotsState =
          policy === "unreachable"
            ? "unreachable"
            : policy === ALLOW_ALL
              ? "allowed-all"
              : "parsed";
        if (policy !== "unreachable") state.crawlDelaySeconds = policy.crawlDelaySeconds;
        return policy;
      });
    }
    return state.robots;
  }

  async function fetchWithRetries(
    state: HostState,
    url: string,
    getOptions: GetOptions,
  ): Promise<FetchOutcome> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (getOptions.etag) {
      headers["if-none-match"] = getOptions.etag;
      // Without this, fetch adds `Cache-Control: no-cache` to conditional requests (as the
      // Fetch standard says), and some servers (Lever) then never answer 304.
      headers["cache-control"] = "max-age=0";
    }
    const limit = { maxBytes, truncate: false };
    for (let attempt = 1; ; attempt += 1) {
      const result = await send(
        state,
        url,
        { headers, redirect: "manual" },
        limit,
        getOptions.signal,
      );
      let failure: FetchFailure;
      let status: number | null = null;
      let message: string;
      let retryAfterMs: number | undefined;

      if (result.kind === "error") {
        failure = result.failure;
        message = result.message;
      } else {
        status = result.status;
        if (status >= 200 && status < 300) {
          if (result.tooLarge) {
            return fail("too-large", status, `Response exceeds ${maxBytes} bytes`, attempt);
          }
          return {
            kind: "ok",
            status,
            body: result.body,
            etag: result.headers.get("etag"),
            bytes: result.bytes,
            attempts: attempt,
          };
        }
        if (status === 304 && getOptions.etag) return { kind: "not-modified", attempts: attempt };
        if (status === 404 || status === 410)
          return { kind: "not-found", status, attempts: attempt };
        if (status >= 300 && status < 400 && status !== 304) {
          const location = result.headers.get("location") ?? "no location";
          return fail("redirect", status, `Redirected to ${location}`, attempt);
        }
        if (status !== 429 && status !== 408 && status < 500) {
          return fail("http-error", status, `HTTP ${status}`, attempt);
        }
        failure = status >= 500 ? "server-error" : status === 429 ? "rate-limited" : "timeout";
        message = `HTTP ${status}`;
        retryAfterMs = parseRetryAfter(result.headers.get("retry-after"), now());
      }

      if (retryAfterMs !== undefined && retryAfterMs > maxRetryAfterMs) {
        return fail("retry-after-too-long", status, `Retry-After of ${retryAfterMs} ms`, attempt);
      }
      if (attempt > maxRetries) return fail(failure, status, message, attempt);
      state.retries += 1;
      const delay = backoffDelay(attempt, backoffBaseMs, backoffCapMs, random);
      await sleep(Math.max(delay, retryAfterMs ?? 0));
      getOptions.signal?.throwIfAborted();
    }
  }

  function fail(
    failure: FetchFailure,
    status: number | null,
    message: string,
    attempts: number,
  ): FetchOutcome {
    return { kind: "failed", failure, status, message, attempts };
  }

  return {
    async get(url, getOptions = {}) {
      const target = new URL(url);
      const state = hostState(target.host);
      if (state.consecutiveFailures >= breakerThreshold) {
        return { kind: "skipped", reason: "circuit-open" };
      }
      const robots = await robotsFor(state, target.origin);
      if (robots === "unreachable") return { kind: "skipped", reason: "robots-unreachable" };
      if (!robots.isAllowed(`${target.pathname}${target.search}`)) {
        return { kind: "skipped", reason: "disallowed" };
      }

      const outcome = await exclusive(state, () => {
        // The breaker may have opened while this request waited for its turn.
        if (state.consecutiveFailures >= breakerThreshold) {
          return Promise.resolve<FetchOutcome>({ kind: "skipped", reason: "circuit-open" });
        }
        return fetchWithRetries(state, url, getOptions);
      });
      if (outcome.kind === "failed") {
        state.failures += 1;
        if (HOST_FAILURES.has(outcome.failure)) state.consecutiveFailures += 1;
      } else if (outcome.kind !== "skipped") {
        state.consecutiveFailures = 0;
      }
      return outcome;
    },

    stats() {
      return new Map(
        [...hosts].map(([host, state]) => [
          host,
          {
            requests: state.requests,
            retries: state.retries,
            failures: state.failures,
            bytes: state.bytes,
            circuitOpen: state.consecutiveFailures >= breakerThreshold,
            robots: state.robotsState,
            crawlDelaySeconds: state.crawlDelaySeconds,
          },
        ]),
      );
    },
  };
}

/**
 * Reads a response body as UTF-8, stopping at the limit: either keeping what fits (robots.txt,
 * where the RFC allows ignoring the rest) or reporting the body as too large.
 */
async function readBody(
  response: Response,
  limit: BodyLimit,
): Promise<{ body: string; bytes: number; tooLarge: boolean }> {
  const reader = response.body?.getReader();
  if (reader === undefined) return { body: "", bytes: 0, tooLarge: false };
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (bytes + value.byteLength > limit.maxBytes) {
      await reader.cancel();
      if (!limit.truncate) return { body: "", bytes: bytes + value.byteLength, tooLarge: true };
      chunks.push(value.subarray(0, limit.maxBytes - bytes));
      bytes = limit.maxBytes;
      break;
    }
    chunks.push(value);
    bytes += value.byteLength;
  }
  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body: new TextDecoder().decode(merged), bytes, tooLarge: false };
}
