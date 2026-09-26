import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRateLimiter } from "./rate-limiter.ts";

/** A virtual clock: sleeping advances time instantly and records how long each wait was. */
function virtualTime() {
  let now = 0;
  const waits: number[] = [];
  return {
    now: () => now,
    sleep: (ms: number) => {
      waits.push(ms);
      now += ms;
      return Promise.resolve();
    },
    waits,
    elapsed: () => now,
  };
}

async function settle(): Promise<void> {
  for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
}

describe("createRateLimiter", () => {
  it("allows a burst of one second of requests, then spaces them at the limit", async () => {
    const time = virtualTime();
    const limiter = createRateLimiter({ requestsPerMinute: 120, maxConcurrent: 10, ...time });

    for (let request = 0; request < 6; request += 1) {
      const release = await limiter.acquire();
      release();
    }

    // Two requests per second: the first two go at once, the next four wait 500 ms each.
    expect(time.waits).toEqual([500, 500, 500, 500]);
    expect(time.elapsed()).toBe(2_000);
  });

  it("never runs more than maxConcurrent requests at once", async () => {
    const limiter = createRateLimiter({
      requestsPerMinute: 60_000,
      maxConcurrent: 2,
      ...virtualTime(),
    });
    const releases: Array<() => void> = [];
    for (let request = 0; request < 5; request += 1) {
      void limiter.acquire().then((release) => releases.push(release));
    }

    await settle();
    expect(releases).toHaveLength(2);

    releases[0]?.();
    await settle();
    expect(releases).toHaveLength(3);
  });

  it("serves waiting callers in arrival order", async () => {
    const limiter = createRateLimiter({
      requestsPerMinute: 60_000,
      maxConcurrent: 1,
      ...virtualTime(),
    });
    const order: number[] = [];
    const first = await limiter.acquire();
    const waiting = [1, 2, 3].map((id) =>
      limiter.acquire().then((release) => {
        order.push(id);
        release();
      }),
    );

    first();
    await Promise.all(waiting);
    expect(order).toEqual([1, 2, 3]);
  });

  it("gives up a queued slot when the caller aborts", async () => {
    const limiter = createRateLimiter({
      requestsPerMinute: 60_000,
      maxConcurrent: 1,
      ...virtualTime(),
    });
    const holder = await limiter.acquire();
    const controller = new AbortController();
    const abandoned = limiter.acquire(controller.signal);
    controller.abort(new Error("caller gave up"));

    await expect(abandoned).rejects.toThrow("caller gave up");
    holder();
    const next = await limiter.acquire();
    expect(typeof next).toBe("function");
  });

  describe("with the default timer", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("waits on a real timer until a token is available", async () => {
      const limiter = createRateLimiter({ requestsPerMinute: 60, maxConcurrent: 5 });
      (await limiter.acquire())();

      let acquired = false;
      void limiter.acquire().then(() => {
        acquired = true;
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(acquired).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(acquired).toBe(true);
    });

    it("stops waiting when the caller aborts", async () => {
      const limiter = createRateLimiter({ requestsPerMinute: 60, maxConcurrent: 5 });
      (await limiter.acquire())();

      const controller = new AbortController();
      const waiting = limiter.acquire(controller.signal);
      controller.abort(new Error("cancelled"));
      await expect(waiting).rejects.toThrow("cancelled");
    });
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const limiter = createRateLimiter({ requestsPerMinute: 60, maxConcurrent: 1 });
    await expect(limiter.acquire(AbortSignal.abort(new Error("stop")))).rejects.toThrow("stop");
  });

  it("ignores repeated releases", async () => {
    const limiter = createRateLimiter({
      requestsPerMinute: 60_000,
      maxConcurrent: 1,
      ...virtualTime(),
    });
    const release = await limiter.acquire();
    release();
    release();

    const second = await limiter.acquire();
    let thirdAcquired = false;
    void limiter.acquire().then(() => {
      thirdAcquired = true;
    });
    await settle();
    expect(thirdAcquired).toBe(false);
    second();
  });

  it.each([
    { requestsPerMinute: 0, maxConcurrent: 1 },
    { requestsPerMinute: 60, maxConcurrent: 0 },
    { requestsPerMinute: 1.5, maxConcurrent: 1 },
  ])("rejects invalid options %o", (options) => {
    expect(() => createRateLimiter(options)).toThrow(RangeError);
  });
});
