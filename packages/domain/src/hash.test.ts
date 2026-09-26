import { describe, expect, it } from "vitest";
import { contentHash, sha256, sha256Hex } from "./hash.ts";

describe("sha256Hex", () => {
  it("matches the FIPS 180-2 test vectors", async () => {
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hashes bytes and their UTF-8 string identically", async () => {
    const bytes = new TextEncoder().encode("abc");
    expect(await sha256Hex(bytes)).toBe(await sha256Hex("abc"));
  });
});

describe("sha256", () => {
  it("returns a 32-byte digest", async () => {
    expect((await sha256("abc")).byteLength).toBe(32);
  });
});

describe("contentHash", () => {
  it("ignores key order", async () => {
    expect(await contentHash({ a: 1, b: [1, 2] })).toBe(await contentHash({ b: [1, 2], a: 1 }));
  });

  it("distinguishes different values", async () => {
    expect(await contentHash({ a: 1 })).not.toBe(await contentHash({ a: 2 }));
    expect(await contentHash([1, 2])).not.toBe(await contentHash([2, 1]));
  });
});
