import { beforeEach, describe, expect, it } from "vitest";
import { authorization, lock, NotUnlockedError, unlock, unlocked } from "./credentials.ts";

beforeEach(() => {
  lock();
});

describe("the secret", () => {
  it("is not held until one is given", () => {
    expect(unlocked()).toBe(false);
    expect(() => authorization()).toThrow(NotUnlockedError);
  });

  it("becomes a bearer header once given", () => {
    unlock("a-secret-of-at-least-24-chars");
    expect(unlocked()).toBe(true);
    expect(authorization()).toBe("Bearer a-secret-of-at-least-24-chars");
  });

  it("is trimmed, because a pasted secret often brings whitespace", () => {
    unlock("  a-secret-of-at-least-24-chars \n");
    expect(authorization()).toBe("Bearer a-secret-of-at-least-24-chars");
  });

  it("refuses one too short to be the server's, without a round trip", () => {
    expect(() => unlock("short")).toThrow(NotUnlockedError);
    expect(unlocked()).toBe(false);
  });

  it("is forgotten on request", () => {
    unlock("a-secret-of-at-least-24-chars");
    lock();
    expect(unlocked()).toBe(false);
    expect(() => authorization()).toThrow(NotUnlockedError);
  });

  it("is never written to any storage", () => {
    // The whole point of holding it in memory is that it outlives nothing. If this module ever
    // reaches for a storage API, that decision has been quietly reversed, and the test that
    // would otherwise catch it is one nobody writes.
    const reads: string[] = [];
    const trap = new Proxy(
      {},
      {
        get: (_target, name) => {
          reads.push(String(name));
          return () => undefined;
        },
        set: (_target, name) => {
          reads.push(String(name));
          return true;
        },
      },
    );
    const globals = globalThis as unknown as Record<string, unknown>;
    const before = { local: globals["localStorage"], session: globals["sessionStorage"] };
    globals["localStorage"] = trap;
    globals["sessionStorage"] = trap;
    try {
      unlock("a-secret-of-at-least-24-chars");
      authorization();
      lock();
    } finally {
      globals["localStorage"] = before.local;
      globals["sessionStorage"] = before.session;
    }
    expect(reads).toEqual([]);
  });
});
