/**
 * Limits both concurrency and request rate. The rate uses a token bucket that holds at most
 * one second of requests, so bursts stay small and sustained traffic converges on the limit.
 * Callers are served in arrival order.
 */
export interface RateLimiter {
  /**
   * Waits for a concurrency slot and a request token. Call the returned function once the
   * request has finished; calling it more than once has no further effect.
   */
  acquire(signal?: AbortSignal): Promise<() => void>;
}

export interface RateLimiterOptions {
  readonly requestsPerMinute: number;
  readonly maxConcurrent: number;
  /** Clock in milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Waits `ms` milliseconds, rejecting if `signal` aborts. Defaults to a timer. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** One request's worth of bucket credit: the number of milliseconds in a minute. */
const CREDITS_PER_REQUEST = 60_000;

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const requestsPerMinute = positiveInteger("requestsPerMinute", options.requestsPerMinute);
  const maxConcurrent = positiveInteger("maxConcurrent", options.maxConcurrent);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;

  // The bucket counts integer credits so the arithmetic stays exact: a request costs
  // CREDITS_PER_REQUEST and the bucket refills `requestsPerMinute` credits per millisecond.
  const capacity = Math.max(1, Math.floor(requestsPerMinute / 60)) * CREDITS_PER_REQUEST;
  let credits = capacity;
  let refilledAt = now();
  let active = 0;
  const waiters: Array<() => void> = [];
  let tokenTurn: Promise<void> = Promise.resolve();

  function refill(): void {
    const current = now();
    credits = Math.min(capacity, credits + (current - refilledAt) * requestsPerMinute);
    refilledAt = current;
  }

  async function takeToken(signal?: AbortSignal): Promise<void> {
    const previousTurn = tokenTurn;
    let endTurn = (): void => {};
    tokenTurn = new Promise<void>((resolve) => {
      endTurn = resolve;
    });
    try {
      await previousTurn;
      refill();
      while (credits < CREDITS_PER_REQUEST) {
        await sleep(Math.ceil((CREDITS_PER_REQUEST - credits) / requestsPerMinute), signal);
        refill();
      }
      credits -= CREDITS_PER_REQUEST;
    } finally {
      endTurn();
    }
  }

  function takeSlot(signal?: AbortSignal): Promise<void> {
    if (active < maxConcurrent) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        const index = waiters.indexOf(grant);
        if (index !== -1) waiters.splice(index, 1);
        reject(signal?.reason);
      };
      const grant = (): void => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      waiters.push(grant);
    });
  }

  function releaseSlot(): void {
    const next = waiters.shift();
    // Hand the slot straight to the next waiter; `active` only drops when nobody is waiting.
    if (next) next();
    else active -= 1;
  }

  return {
    async acquire(signal) {
      signal?.throwIfAborted();
      await takeSlot(signal);
      try {
        await takeToken(signal);
      } catch (error) {
        releaseSlot();
        throw error;
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        releaseSlot();
      };
    },
  };
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer, got ${value}`);
  }
  return value;
}
