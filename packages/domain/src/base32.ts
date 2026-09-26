const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/**
 * RFC 4648 base32 in lowercase without padding. Identifiers built with it are URL-safe and
 * case-insensitive, and every character carries 5 bits.
 */
export function base32(bytes: Uint8Array): string {
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += ALPHABET.charAt((buffer >>> bits) & 31);
    }
  }
  if (bits > 0) output += ALPHABET.charAt((buffer << (5 - bits)) & 31);
  return output;
}
