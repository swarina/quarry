import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { ATS_SOURCES, isAtsSource } from "./ats-source.ts";
import { boardId, isPostingId, isValidSlug, parseBoardId, postingId } from "./ids.ts";

const slug = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._-]{0,20}$/);

describe("isAtsSource", () => {
  it("accepts every source and nothing else", () => {
    for (const source of ATS_SOURCES) expect(isAtsSource(source)).toBe(true);
    expect(isAtsSource("workday")).toBe(false);
    expect(isAtsSource("Greenhouse")).toBe(false);
  });
});

describe("boardId", () => {
  it("joins source and lowercase slug", () => {
    expect(boardId("greenhouse", "Stripe")).toBe("greenhouse:stripe");
    expect(boardId("lever-eu", "alice-bob")).toBe("lever-eu:alice-bob");
  });

  it("rejects slugs that are not URL-safe", () => {
    for (const bad of ["", "-lead", "a/b", "a b", "a?b", "é", "x".repeat(101)]) {
      expect(isValidSlug(bad)).toBe(false);
      expect(() => boardId("ashby", bad)).toThrow(RangeError);
    }
  });

  test.prop([fc.constantFrom(...ATS_SOURCES), slug])(
    "round-trips through parseBoardId",
    (source, value) => {
      expect(parseBoardId(boardId(source, value))).toEqual({ source, slug: value.toLowerCase() });
    },
  );
});

describe("parseBoardId", () => {
  it("rejects malformed ids", () => {
    for (const bad of ["stripe", "workday:acme", "greenhouse:", "greenhouse:Stripe", ":stripe"]) {
      expect(parseBoardId(bad)).toBeUndefined();
    }
  });
});

describe("postingId", () => {
  it("is stable across releases (changing it would orphan every stored posting)", async () => {
    // Computed independently: base64.b32encode(sha256(b"greenhouse:stripe:7850544003")) in Python.
    expect(await postingId(boardId("greenhouse", "stripe"), "7850544003")).toBe("p4mmby6s62axi4o7");
    expect(await postingId(boardId("greenhouse", "STRIPE"), "7850544003")).toBe("p4mmby6s62axi4o7");
  });

  it("depends on both board and external id", async () => {
    const board = boardId("lever", "acme");
    expect(await postingId(board, "1")).not.toBe(await postingId(board, "2"));
    expect(await postingId(board, "1")).not.toBe(await postingId(boardId("lever-eu", "acme"), "1"));
  });

  it("rejects an empty external id", async () => {
    await expect(postingId(boardId("ashby", "acme"), "")).rejects.toThrow(RangeError);
  });

  test.prop([fc.constantFrom(...ATS_SOURCES), slug, fc.string({ minLength: 1 })])(
    "always produces a valid posting id",
    async (source, value, externalId) => {
      expect(isPostingId(await postingId(boardId(source, value), externalId))).toBe(true);
    },
  );

  it("recognizes only well-formed posting ids", () => {
    expect(isPostingId("abcdefghijklmnop")).toBe(true);
    expect(isPostingId("abcdefghijklmno")).toBe(false);
    expect(isPostingId("ABCDEFGHIJKLMNOP")).toBe(false);
    expect(isPostingId("abcdefghijklmno1")).toBe(false);
  });
});
