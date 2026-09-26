import { canonicalJson } from "./canonical-json.ts";

const encoder = new TextEncoder();

/** SHA-256 of a UTF-8 string or raw bytes, via WebCrypto (Node.js, Workers, and browsers). */
export async function sha256(input: string | Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const bytes = typeof input === "string" ? encoder.encode(input) : input;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

/** Lowercase hex SHA-256 of a UTF-8 string or raw bytes. */
export async function sha256Hex(input: string | Uint8Array<ArrayBuffer>): Promise<string> {
  return toHex(await sha256(input));
}

/**
 * Hex SHA-256 of the canonical JSON form of `value`, so equal values always share a hash
 * regardless of key order or Unicode normalization. Throws `CanonicalJsonError` for values
 * JSON cannot represent.
 */
export async function contentHash(value: unknown): Promise<string> {
  return sha256Hex(canonicalJson(value));
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}
