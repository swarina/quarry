import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { CanonicalJsonError, canonicalJson } from "./canonical-json.ts";

const COMPOSED_E = String.fromCodePoint(0xe9);
const DECOMPOSED_E = String.fromCodePoint(0x65, 0x301);

describe("canonicalJson", () => {
  it("sorts object keys and omits whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 2], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[3,2]},"b":1}',
    );
  });

  it("orders keys by UTF-16 code units", () => {
    expect(canonicalJson({ b: 1, B: 2, a: 3, _: 4 })).toBe('{"B":2,"_":4,"a":3,"b":1}');
  });

  it("serializes primitives like JSON", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(1.5e-7)).toBe("1.5e-7");
    expect(canonicalJson(-0)).toBe("0");
    expect(canonicalJson('quote " and \\ backslash')).toBe('"quote \\" and \\\\ backslash"');
  });

  it("normalizes strings and keys to NFC", () => {
    expect(canonicalJson(DECOMPOSED_E)).toBe(canonicalJson(COMPOSED_E));
    expect(canonicalJson({ [DECOMPOSED_E]: 1 })).toBe(canonicalJson({ [COMPOSED_E]: 1 }));
  });

  it("omits properties whose value is undefined", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("accepts objects without a prototype", () => {
    const value: Record<string, number> = Object.create(null);
    value["a"] = 1;
    expect(canonicalJson(value)).toBe('{"a":1}');
  });

  it("allows the same object to appear in separate branches", () => {
    const shared = { x: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a bigint", 1n],
    ["a function", () => 1],
    ["a symbol", Symbol("s")],
    ["undefined", undefined],
    ["a Date", new Date(0)],
    ["a Map", new Map()],
    ["an undefined array element", [1, undefined]],
    ["an array hole", new Array<number>(3)],
  ])("rejects %s", (_label, value) => {
    expect(() => canonicalJson(value)).toThrow(CanonicalJsonError);
  });

  it("rejects circular references and reports where", () => {
    const value: { self?: unknown } = {};
    value.self = value;
    expect(() => canonicalJson(value)).toThrow(/Circular reference at \$\.self/);
  });

  it("rejects keys that collide after normalization", () => {
    expect(() => canonicalJson({ [COMPOSED_E]: 1, [DECOMPOSED_E]: 2 })).toThrow(/collide/);
  });

  test.prop([fc.jsonValue()])("always produces valid JSON", (value) => {
    expect(() => JSON.parse(canonicalJson(value))).not.toThrow();
  });

  test.prop([fc.jsonValue()])("is stable through a JSON round trip", (value) => {
    const once = canonicalJson(value);
    expect(canonicalJson(JSON.parse(once))).toBe(once);
  });

  test.prop([fc.dictionary(fc.string(), fc.jsonValue())])(
    "does not depend on key insertion order",
    (value) => {
      const reversed = Object.fromEntries(Object.entries(value).reverse());
      expect(canonicalJson(reversed)).toBe(canonicalJson(value));
    },
  );
});
