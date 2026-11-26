/**
 * The per-caller gate in front of the criterion routes.
 *
 * The property that matters most is the last one here: nothing downstream of the gate runs for a
 * caller it turns away, which is what makes a refused request cost no D1 read.
 */
import { describe, expect, it } from "vitest";
import {
  callerOf,
  createRateLimitGate,
  REQUESTS_PER_MINUTE,
  underRateLimit,
} from "./rate-limit.ts";

function at(ms: number): () => number {
  return () => ms;
}

/** A clock a test advances by hand. */
function clock(start = 0): { now: () => number; advance(ms: number): void } {
  let current = start;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
    },
  };
}

function post(headers: Record<string, string> = {}): Request {
  return new Request("https://quarry.example/criteria/estimate", { method: "POST", headers });
}

describe("the rate limit gate", () => {
  it("allows requests up to the limit and refuses the next one", () => {
    const gate = createRateLimitGate({ requestsPerWindow: 3, windowMs: 1000, now: at(0) });
    expect([gate.allow("a"), gate.allow("a"), gate.allow("a")]).toEqual([true, true, true]);
    expect(gate.allow("a")).toBe(false);
  });

  it("counts callers apart from one another", () => {
    const gate = createRateLimitGate({ requestsPerWindow: 1, windowMs: 1000, now: at(0) });
    expect(gate.allow("a")).toBe(true);
    expect(gate.allow("a")).toBe(false);
    expect(gate.allow("b")).toBe(true);
  });

  it("starts a fresh count when the window turns", () => {
    const time = clock(0);
    const gate = createRateLimitGate({ requestsPerWindow: 1, windowMs: 1000, now: time.now });
    expect(gate.allow("a")).toBe(true);
    expect(gate.allow("a")).toBe(false);
    time.advance(1000);
    expect(gate.allow("a")).toBe(true);
  });

  it("keeps counting within a window that has not turned", () => {
    const time = clock(0);
    const gate = createRateLimitGate({ requestsPerWindow: 1, windowMs: 1000, now: time.now });
    expect(gate.allow("a")).toBe(true);
    time.advance(999);
    expect(gate.allow("a")).toBe(false);
  });

  it("turns away a caller it has no room to count", () => {
    const gate = createRateLimitGate({
      requestsPerWindow: 10,
      windowMs: 1000,
      maxCallers: 2,
      now: at(0),
    });
    expect(gate.allow("a")).toBe(true);
    expect(gate.allow("b")).toBe(true);
    // The table is full, so a third caller is refused rather than let through uncounted.
    expect(gate.allow("c")).toBe(false);
    // The two already being counted are unaffected.
    expect(gate.allow("a")).toBe(true);
  });

  it("limits a minute's worth of requests by default", () => {
    const gate = createRateLimitGate({ now: at(0) });
    for (let sent = 0; sent < REQUESTS_PER_MINUTE; sent += 1) {
      expect(gate.allow("a")).toBe(true);
    }
    expect(gate.allow("a")).toBe(false);
  });
});

describe("the caller a request is charged to", () => {
  it("is the address Cloudflare saw", () => {
    expect(callerOf(post({ "CF-Connecting-IP": "198.51.100.7" }))).toBe("198.51.100.7");
  });

  it("is one shared bucket when no address is given", () => {
    expect(callerOf(post())).toBe("unidentified");
  });
});

describe("running under the rate limit", () => {
  it("passes an allowed request through to the handler", async () => {
    const gate = createRateLimitGate({ requestsPerWindow: 1, windowMs: 1000, now: at(0) });
    const response = await underRateLimit(post(), gate, async () => new Response("ok"));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  it("answers 429 with a retry hint and runs nothing downstream", async () => {
    const gate = createRateLimitGate({ requestsPerWindow: 1, windowMs: 1000, now: at(0) });
    let ran = 0;
    const handle = async (): Promise<Response> => {
      ran += 1;
      return new Response("ok");
    };
    expect((await underRateLimit(post(), gate, handle, 1000)).status).toBe(200);

    const refused = await underRateLimit(post(), gate, handle, 1000);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("1");
    expect(refused.headers.get("cache-control")).toBe("no-store");
    expect(await refused.json()).toEqual({
      error: { code: "RATE_LIMITED", message: "too many requests; try again shortly" },
    });
    // The handler, and so every D1 read it would make, never ran for the refused request.
    expect(ran).toBe(1);
  });

  it("limits each caller on its own, whichever route they call", async () => {
    const gate = createRateLimitGate({ requestsPerWindow: 1, windowMs: 1000, now: at(0) });
    const one = post({ "CF-Connecting-IP": "198.51.100.7" });
    const two = post({ "CF-Connecting-IP": "198.51.100.8" });
    const handle = async (): Promise<Response> => new Response("ok");
    expect((await underRateLimit(one, gate, handle)).status).toBe(200);
    expect((await underRateLimit(one, gate, handle)).status).toBe(429);
    expect((await underRateLimit(two, gate, handle)).status).toBe(200);
  });
});
