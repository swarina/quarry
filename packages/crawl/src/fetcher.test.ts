import { describe, expect, it } from "vitest";
import { backoffDelay, parseRetryAfter } from "./backoff.ts";
import { createPoliteFetcher, type PoliteFetcherOptions } from "./fetcher.ts";

/** A reply is built per request, because a Response body can only be read once. */
type Reply = Error | ((request: Request) => Response | Error);

/**
 * A scripted server and a virtual clock: `sleep` advances time instantly, and every request is
 * logged with the time it was sent.
 */
function harness(
  routes: Record<string, Reply | Reply[]>,
  overrides: Partial<PoliteFetcherOptions> = {},
) {
  let clock = 1_000_000;
  const log: { url: string; at: number; headers: Headers }[] = [];
  const sleeps: number[] = [];
  const queues = new Map(Object.entries(routes).map(([url, reply]) => [url, [reply].flat()]));
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    log.push({ url: request.url, at: clock, headers: request.headers });
    const queue = queues.get(request.url);
    if (queue === undefined) return new Response("missing", { status: 404 });
    const reply = queue.length > 1 ? queue.shift() : queue[0];
    const resolved = typeof reply === "function" ? reply(request) : reply;
    if (resolved instanceof Error) throw resolved;
    return resolved;
  };
  const fetcher = createPoliteFetcher({
    userAgent: "QuarryBot/1.0 (+https://example.com)",
    productToken: "QuarryBot",
    fetch: fetch as typeof globalThis.fetch,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    random: () => 0.5,
    ...overrides,
  });
  return { fetcher, log, sleeps, advance: (ms: number) => (clock += ms) };
}

const ROBOTS = "https://api.example.com/robots.txt";
const JOBS = "https://api.example.com/v1/jobs";
const json =
  (body: unknown, init: ResponseInit = {}) =>
  () =>
    new Response(JSON.stringify(body), { status: 200, ...init });
const status =
  (code: number, headers: Record<string, string> = {}) =>
  () =>
    new Response(null, { status: code, headers });
const text = (body: string) => () => new Response(body);

describe("createPoliteFetcher", () => {
  it("fetches robots.txt first, identifies itself, and returns the body and ETag", async () => {
    const { fetcher, log } = harness({
      [ROBOTS]: text("User-agent: *\nAllow: /\n"),
      [JOBS]: json({ jobs: [] }, { headers: { etag: 'W/"abc"' } }),
    });
    const outcome = await fetcher.get(JOBS);
    expect(outcome).toEqual({
      kind: "ok",
      status: 200,
      body: '{"jobs":[]}',
      etag: 'W/"abc"',
      bytes: 11,
      attempts: 1,
    });
    expect(log.map((entry) => entry.url)).toEqual([ROBOTS, JOBS]);
    expect(log[1]?.headers.get("user-agent")).toBe("QuarryBot/1.0 (+https://example.com)");
    expect(log[1]?.headers.get("accept")).toBe("application/json");
  });

  it("fetches robots.txt once per host", async () => {
    const { fetcher, log } = harness({ [ROBOTS]: text(""), [JOBS]: json([]) });
    await fetcher.get(JOBS);
    await fetcher.get(JOBS);
    expect(log.filter((entry) => entry.url === ROBOTS)).toHaveLength(1);
  });

  it("skips paths robots.txt disallows without requesting them", async () => {
    const { fetcher, log } = harness({
      [ROBOTS]: text("User-agent: QuarryBot\nDisallow: /v1/\n"),
      [JOBS]: json([]),
    });
    expect(await fetcher.get(JOBS)).toEqual({ kind: "skipped", reason: "disallowed" });
    expect(log.map((entry) => entry.url)).toEqual([ROBOTS]);
  });

  it("treats a 4xx robots.txt as no rules and a failing one as unreachable", async () => {
    const missing = harness({ [ROBOTS]: status(401), [JOBS]: json([]) });
    expect((await missing.fetcher.get(JOBS)).kind).toBe("ok");
    expect(missing.fetcher.stats().get("api.example.com")?.robots).toBe("allowed-all");

    const down = harness({ [ROBOTS]: status(503), [JOBS]: json([]) });
    expect(await down.fetcher.get(JOBS)).toEqual({ kind: "skipped", reason: "robots-unreachable" });
    expect(down.log.filter((entry) => entry.url === JOBS)).toHaveLength(0);
    expect(down.log).toHaveLength(3);

    const limited = harness({ [ROBOTS]: status(429), [JOBS]: json([]) });
    expect((await limited.fetcher.get(JOBS)).kind).toBe("skipped");
  });

  it("keeps at least the minimum gap, or the crawl delay, between requests to a host", async () => {
    const { fetcher, log } = harness(
      { [ROBOTS]: text("User-agent: *\nCrawl-delay: 3\n"), [JOBS]: json([]) },
      { minGapMs: 1_000 },
    );
    await Promise.all([fetcher.get(JOBS), fetcher.get(JOBS), fetcher.get(JOBS)]);
    const gaps = log.slice(1).map((entry, index) => entry.at - (log[index]?.at ?? 0));
    expect(gaps).toHaveLength(3);
    expect(gaps[0]).toBeGreaterThanOrEqual(1_000);
    expect(gaps[1]).toBeGreaterThanOrEqual(3_000);
    expect(gaps[2]).toBeGreaterThanOrEqual(3_000);
  });

  it("does not make one host wait for another", async () => {
    const other = "https://other.example.com";
    const { fetcher, log } = harness({
      [ROBOTS]: text(""),
      [JOBS]: json([]),
      [`${other}/robots.txt`]: text(""),
      [`${other}/jobs`]: json([]),
    });
    await Promise.all([fetcher.get(JOBS), fetcher.get(`${other}/jobs`)]);
    const firstJobs = log.find((entry) => entry.url === JOBS)?.at;
    const firstOther = log.find((entry) => entry.url === `${other}/jobs`)?.at;
    expect(firstJobs).toBe(firstOther);
  });

  it("sends If-None-Match and reports 304 as not modified", async () => {
    const { fetcher, log } = harness({ [ROBOTS]: text(""), [JOBS]: status(304) });
    expect(await fetcher.get(JOBS, { etag: 'W/"abc"' })).toEqual({
      kind: "not-modified",
      attempts: 1,
    });
    expect(log[1]?.headers.get("if-none-match")).toBe('W/"abc"');
    expect(log[1]?.headers.get("cache-control")).toBe("max-age=0");
  });

  it("reports 404 and 410 as not found without retrying", async () => {
    const { fetcher, log } = harness({ [ROBOTS]: text(""), [JOBS]: status(404) });
    expect(await fetcher.get(JOBS)).toEqual({ kind: "not-found", status: 404, attempts: 1 });
    expect(log).toHaveLength(2);
    const gone = harness({ [ROBOTS]: text(""), [JOBS]: status(410) });
    expect((await gone.fetcher.get(JOBS)).kind).toBe("not-found");
  });

  it("retries server errors and network failures with jittered backoff", async () => {
    const { fetcher, sleeps } = harness(
      {
        [ROBOTS]: text(""),
        [JOBS]: [status(503), new TypeError("fetch failed"), json(["ok"])],
      },
      { backoffBaseMs: 2_000, minGapMs: 0 },
    );
    const outcome = await fetcher.get(JOBS);
    expect(outcome).toMatchObject({ kind: "ok", attempts: 3 });
    expect(sleeps).toEqual([1_000, 2_000]);
    expect(fetcher.stats().get("api.example.com")?.retries).toBe(2);
  });

  it("gives up after the retry budget and reports the last failure", async () => {
    const { fetcher, log } = harness(
      { [ROBOTS]: text(""), [JOBS]: status(502) },
      { maxRetries: 2 },
    );
    expect(await fetcher.get(JOBS)).toEqual({
      kind: "failed",
      failure: "server-error",
      status: 502,
      message: "HTTP 502",
      attempts: 3,
    });
    expect(log.filter((entry) => entry.url === JOBS)).toHaveLength(3);
  });

  it("honors Retry-After, and fails fast when it asks for too long", async () => {
    const polite = harness(
      { [ROBOTS]: text(""), [JOBS]: [status(429, { "retry-after": "30" }), json([])] },
      { minGapMs: 0 },
    );
    expect((await polite.fetcher.get(JOBS)).kind).toBe("ok");
    expect(polite.sleeps).toEqual([30_000]);

    const tooLong = harness(
      { [ROBOTS]: text(""), [JOBS]: status(429, { "retry-after": "3600" }) },
      { maxRetryAfterMs: 300_000 },
    );
    expect(await tooLong.fetcher.get(JOBS)).toMatchObject({
      kind: "failed",
      failure: "retry-after-too-long",
      status: 429,
      attempts: 1,
    });
  });

  it("does not retry other client errors or follow redirects", async () => {
    const forbidden = harness({ [ROBOTS]: text(""), [JOBS]: status(403) });
    expect(await forbidden.fetcher.get(JOBS)).toMatchObject({ failure: "http-error", status: 403 });
    const moved = harness({
      [ROBOTS]: text(""),
      [JOBS]: status(301, { location: "https://elsewhere.example.com/" }),
    });
    expect(await moved.fetcher.get(JOBS)).toMatchObject({
      failure: "redirect",
      message: "Redirected to https://elsewhere.example.com/",
    });
    const unexpected = harness({ [ROBOTS]: text(""), [JOBS]: status(304) });
    expect(await unexpected.fetcher.get(JOBS)).toMatchObject({
      failure: "http-error",
      status: 304,
    });
  });

  it("reports timeouts separately from other network errors", async () => {
    const timeout = new DOMException("The operation timed out.", "TimeoutError");
    const { fetcher } = harness({ [ROBOTS]: text(""), [JOBS]: timeout }, { maxRetries: 0 });
    expect(await fetcher.get(JOBS)).toMatchObject({ kind: "failed", failure: "timeout" });
  });

  it("refuses responses larger than the limit", async () => {
    const { fetcher } = harness(
      { [ROBOTS]: text(""), [JOBS]: text("x".repeat(2_000)) },
      { maxBytes: 1_000 },
    );
    expect(await fetcher.get(JOBS)).toMatchObject({ kind: "failed", failure: "too-large" });
  });

  it("stops calling a host after consecutive failures", async () => {
    const { fetcher, log } = harness(
      { [ROBOTS]: text(""), [JOBS]: status(500) },
      { maxRetries: 0, breakerThreshold: 2 },
    );
    expect((await fetcher.get(JOBS)).kind).toBe("failed");
    expect((await fetcher.get(JOBS)).kind).toBe("failed");
    const sent = log.length;
    expect(await fetcher.get(JOBS)).toEqual({ kind: "skipped", reason: "circuit-open" });
    expect(log).toHaveLength(sent);
    expect(fetcher.stats().get("api.example.com")?.circuitOpen).toBe(true);
  });

  it("treats not-found as a healthy host and board-specific failures as not the host's", async () => {
    const { fetcher } = harness(
      {
        [ROBOTS]: text(""),
        [JOBS]: status(500),
        "https://api.example.com/missing": status(404),
        "https://api.example.com/moved": status(301),
      },
      { maxRetries: 0, breakerThreshold: 2 },
    );
    await fetcher.get(JOBS);
    await fetcher.get("https://api.example.com/missing");
    await fetcher.get(JOBS);
    await fetcher.get("https://api.example.com/moved");
    expect(fetcher.stats().get("api.example.com")?.circuitOpen).toBe(false);
  });

  it("resets the failure count after a success", async () => {
    const { fetcher } = harness(
      { [ROBOTS]: text(""), [JOBS]: [status(500), json([]), status(500), status(500)] },
      { maxRetries: 0, breakerThreshold: 2 },
    );
    await fetcher.get(JOBS);
    await fetcher.get(JOBS);
    await fetcher.get(JOBS);
    expect(fetcher.stats().get("api.example.com")?.circuitOpen).toBe(false);
  });

  it("rejects with the caller's abort reason instead of reporting a failure", async () => {
    const controller = new AbortController();
    const { fetcher } = harness({
      [ROBOTS]: text(""),
      [JOBS]: () => {
        controller.abort(new Error("run cancelled"));
        return new TypeError("aborted");
      },
    });
    await expect(fetcher.get(JOBS, { signal: controller.signal })).rejects.toThrow("run cancelled");
  });

  it("counts requests, bytes, and failures per host", async () => {
    const { fetcher } = harness(
      { [ROBOTS]: text("User-agent: *\n"), [JOBS]: [json([1]), status(500)] },
      { maxRetries: 0 },
    );
    await fetcher.get(JOBS);
    await fetcher.get(JOBS);
    expect(fetcher.stats().get("api.example.com")).toEqual({
      requests: 3,
      retries: 0,
      failures: 1,
      bytes: 17,
      circuitOpen: false,
      robots: "parsed",
      crawlDelaySeconds: undefined,
    });
  });
});

describe("backoffDelay", () => {
  it("grows exponentially up to the cap, scaled by the random draw", () => {
    expect(backoffDelay(1, 2_000, 60_000, () => 1)).toBe(2_000);
    expect(backoffDelay(3, 2_000, 60_000, () => 1)).toBe(8_000);
    expect(backoffDelay(10, 2_000, 60_000, () => 1)).toBe(60_000);
    expect(backoffDelay(3, 2_000, 60_000, () => 0.25)).toBe(2_000);
    expect(backoffDelay(3, 2_000, 60_000, () => 0)).toBe(0);
  });
});

describe("parseRetryAfter", () => {
  it("reads delay-seconds and HTTP dates", () => {
    const now = Date.UTC(2026, 8, 27, 12, 0, 0);
    expect(parseRetryAfter("120", now)).toBe(120_000);
    expect(parseRetryAfter("Sun, 27 Sep 2026 12:01:00 GMT", now)).toBe(60_000);
    expect(parseRetryAfter("Sun, 27 Sep 2026 11:00:00 GMT", now)).toBe(0);
  });

  it("returns undefined when missing or malformed", () => {
    expect(parseRetryAfter(null, 0)).toBeUndefined();
    expect(parseRetryAfter("soon", 0)).toBeUndefined();
    expect(parseRetryAfter("-5", 0)).toBeUndefined();
  });
});
