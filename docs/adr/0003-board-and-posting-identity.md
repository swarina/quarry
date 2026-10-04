# ADR-0003: Derive identity from the board and job id, and hash only content

- Status: accepted
- Date: 2026-09-27
- From: #2

## Context

Every crawl of a job must update the same record, and an employer's edit must be
distinguishable from an ATS template change. That needs two separate things: a stable
identity for a posting, and a hash over the part of it that is actually content.

Identity cannot be a database sequence, because the pipeline store is rebuilt from snapshots
on ephemeral runners and the same posting is seen again tomorrow. It also has to be short
enough to appear in URLs and in the search index, where one id per posting is paid for in
download size.

The content hash has a subtler problem. Posting payloads carry things that change without
anyone editing the job: tracking parameters on links, `updatedAt` timestamps, and markup that
shifts when the ATS changes its own templates. Hashing the whole payload would report an edit
every time any of those moved, and enrichment is keyed on content, so a spurious edit costs
real money.

## Options

For identity:

1. **The ATS job id alone.** Short, and collides across boards, since two boards can both
   use the id `1234`.
2. **The full `<source>:<slug>:<job id>` string.** Readable and unbounded in length, which
   the search index pays for on every row.
3. **A truncated hash over the board id and the job id.** Fixed length, deterministic, and
   needs a length chosen against the birthday bound.

For the hash: hash everything, or hash a named subset.

## Decision

Board ids are `<source>:<slug>`, with slugs compared case-insensitively. Posting ids are the
first 80 bits of SHA-256 over the board id and the ATS job id, encoded in RFC 4648 base32,
which gives a 16-character id that is deterministic and URL safe.

`NormalizedPosting` is the single shape every ATS adapter maps to, and `contentHash` covers
only the fields that make up a posting's content. Links, dates, and markup are excluded.
`NORMALIZER_VERSION` versions the mapping itself, so a hash change caused by our own parser
can be told apart from an employer's edit.

Posting text comes from `htmlToText`, a single-pass HTML tokenizer and layout that produces
paragraphs and dash lists. It follows the HTML tokenizer on malformed markup: a stray `<` is
text, a tag cut off by the end of input is dropped, and quoted attributes may contain `>`.

## Consequences

- 80 bits is sized for a corpus of millions, not billions. At 35,000 postings the collision
  probability is negligible; the bound should be rechecked before the corpus grows by three
  orders of magnitude.
- Excluding links from the hash is why apply links had to be carried separately in the index
  later (ADR-0007): they are not content, so they are not in the content row.
- Bumping `NORMALIZER_VERSION` invalidates every stored ETag and refetches every board in
  full once, which is the intended cost of reading postings again with new rules.
- The first `htmlToText` was regex based and quadratic on adversarial markup. The
  single-pass version runs in linear time: 500 KB of adversarial markup in under 50 ms,
  and 11,047 real postings converted in about 1.6 s.
- `entities` 8.1.0 was added for complete HTML5 entity decoding rather than vendoring the
  2,231-entry table. It is maintained, BSD-2-Clause, has no dependencies or install scripts,
  and only its decoder is imported.
