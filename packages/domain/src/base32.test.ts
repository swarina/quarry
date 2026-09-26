import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { base32 } from "./base32.ts";

const encode = (text: string) => base32(new TextEncoder().encode(text));

describe("base32", () => {
  it("matches the RFC 4648 test vectors, lowercased and unpadded", () => {
    expect(encode("")).toBe("");
    expect(encode("f")).toBe("my");
    expect(encode("fo")).toBe("mzxq");
    expect(encode("foo")).toBe("mzxw6");
    expect(encode("foob")).toBe("mzxw6yq");
    expect(encode("fooba")).toBe("mzxw6ytb");
    expect(encode("foobar")).toBe("mzxw6ytboi");
  });

  test.prop([fc.uint8Array({ maxLength: 64 })])(
    "emits ceil(8n / 5) characters from the lowercase alphabet",
    (bytes) => {
      const encoded = base32(bytes);
      expect(encoded).toHaveLength(Math.ceil((bytes.length * 8) / 5));
      expect(encoded).toMatch(/^[a-z2-7]*$/);
    },
  );

  test.prop([fc.uint8Array({ maxLength: 64 }), fc.uint8Array({ maxLength: 64 })])(
    "never maps two different inputs of the same length to the same string",
    (left, right) => {
      fc.pre(left.length === right.length && left.some((byte, index) => byte !== right[index]));
      expect(base32(left)).not.toBe(base32(right));
    },
  );
});
