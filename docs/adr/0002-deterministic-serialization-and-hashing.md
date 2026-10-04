# ADR-0002: One deterministic serialization for cache keys and change detection

- Status: accepted
- Date: 2026-09-26
- From: `d4cfd32`

## Context

Two things in Quarry depend on bytes, not on values. Cache keys decide whether an answer has
already been paid for, and content hashes decide whether an employer edited a posting. Both
are wrong if two semantically equal values can serialize differently.

`JSON.stringify` is not that serialization. Object key order follows insertion order, so the
same record built two ways gives two strings. Unicode is passed through unnormalized, so
text that looks identical can differ in bytes. And it silently coerces values it cannot
represent: `NaN` and `Infinity` become `null`, `undefined` in an array becomes `null`, a
`Date` becomes a string through `toJSON`. Each coercion is a hash collision between values
that are not equal.

## Options

1. **Use `JSON.stringify` and be careful.** No code to own, and every future caller has to
   remember the same rules. The coercions are silent, so a mistake shows up as a cache hit
   on the wrong answer, which is the hardest possible failure to notice.
2. **Adopt a canonical JSON library.** Less code, but another dependency in the one place
   where correctness is load bearing, and most implementations still coerce rather than
   reject.
3. **Write `canonicalJson`, and reject what JSON cannot carry faithfully.** More code to
   own, and the failure mode becomes a thrown error at the call site instead of a wrong hash.

## Decision

Option 3. `canonicalJson` sorts object keys by UTF-16 code units, normalizes strings and keys
to Unicode NFC, and emits no insignificant whitespace. Anything JSON cannot represent
faithfully is rejected rather than coerced: non-finite numbers, bigints, `undefined` array
elements, non-plain objects, and cycles.

`sha256`, `sha256Hex`, and `contentHash` are built on WebCrypto rather than `node:crypto`, so
the same code runs in Node.js, on Cloudflare Workers, and in the browser. That keeps hashing
in portable library code, which ADR-0001 enforces.

## Consequences

- Equal values always hash equally, in every runtime, which is what makes a cross-runtime
  answer cache safe.
- Callers must hand over plain data. Passing a `Date` or a class instance throws instead of
  hashing something surprising, so the conversion has to be explicit at the boundary.
- Sorting by UTF-16 code units, not by code point, is a deliberate choice to match the
  common canonical JSON convention. It only differs for keys outside the basic multilingual
  plane, and the keys here are ASCII field names.
- NFC normalization means a hash is stable across text that differs only by composition,
  which matters because posting text comes from many employers and editors.
