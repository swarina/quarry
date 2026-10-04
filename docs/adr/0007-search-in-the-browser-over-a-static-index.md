# ADR-0007: Filter a static columnar index in the browser

- Status: accepted
- Date: 2026-09-28
- From: #18, #26

## Context

Search is the part of Quarry people touch first: filters over place, arrangement, employment
type, company, recency, and pay, with facet counts that say how many postings each value
would give. At 35,000 postings this is a few megabytes of structured data, and the queries
are all conjunctions over small enumerations.

Running that server-side means a request per keystroke, a database to keep awake, and a cost
per user. Running it in the browser means shipping the data once and paying nothing per
query, if the data can be made small enough to download on a phone.

Facet counts have a subtlety that turns out to matter. A count promises "this many if you
pick me", which means each facet has to be counted over the postings that pass every *other*
filter, not over the current result set.

## Options

1. **A server endpoint over the pipeline store.** Familiar, and needs a hosted database, a
   warm Worker, and a round trip per interaction. Also puts the full corpus behind an API
   that has to be rate limited.
2. **Ship the whole corpus as JSON and filter it in JavaScript.** Trivially simple, and
   object-per-posting JSON at this size is several megabytes gzipped before any of it is
   useful.
3. **A columnar index, sharded by region, filtered in the browser.** Smallest download and
   fastest queries, at the cost of a build step, a format with a version, and dictionaries to
   decode.

## Decision

Option 3. `@quarry/search-index/build` produces columnar JSON shards split by region, plus a
manifest that names them.

- Each posting goes into the shard of every continent it names, or into `anywhere` or
  `unplaced`. Shards are ordered newest first and are self-contained: each carries its own
  dictionaries (companies, labels, countries, divisions and cities, departments, currencies)
  and its own columns, with coded enums, a bit set of employment types, lists stored as
  counts and values, and pay and publish day.
- A region with more than 8,000 rows is split into parts.
- Posting ids are cut to the shortest unique prefix, at least 10 characters.
- A build is named by a hash of its shards and the facet rules, so an unchanged corpus gives
  the same build name.
- Budgets are checked on every build: 600 KB gzipped per shard, 20 KB for the manifest, and
  5,000 files. Going over fails the pipeline run.

In the browser, `openIndex` validates the manifest and the loaded shards and decodes them
into one table of typed arrays. `queryIndex` filters, sorts, pages, and counts facets in a
single pass, counting each facet over the postings that pass every other filter. The browser
never loads the gazetteer.

Two later decisions belong to this record:

- **Apply links live beside the shards, not inside them.** Links cannot be rebuilt from the
  board and job id, because about a tenth of Greenhouse boards publish on the company's own
  domain and a rebuilt link would 404. Carrying them inside the shards cost 38% on every
  download to serve the few postings anyone clicks, so each shard has a links file beside it
  in the same row order, fetched only once results are on screen. `readLinks` refuses a file
  whose length, region, part, or format disagrees, because a silent misalignment would send
  people to the wrong job.
- **No validation library in the browser.** zod was 97 KB gzipped to re-check files we
  generate ourselves and name by content hash, three times the size of the code doing the
  work. The schemas moved to `schema.ts` for the build and its tests, `format.ts` keeps the
  shapes as types, and `parse.ts` checks what a reader fetched by hand. A test parses a real
  build both ways and expects the same result, so the two cannot drift.

Pay is kept in its stated currency and never converted, because conversion belongs to the
salary layer.

## Consequences

- Search costs nothing per query and works with no account and no server, which is also what
  makes ADR-0023 possible.
- The site's bundle went from 463 KB to 23 KB, and 97 KB to 8 KB gzipped.
- Measured on 35,221 postings: shards 1,122 KB gzipped in all, links 567 KB with the largest
  file 132 KB, manifest 6.5 KB of its 20 KB budget. Query p95 was 1 to 5 ms in Node, and
  8.9 ms in a real browser over 34,831 postings against the 100 ms target.
- Every format change is a version bump and a full rebuild. `INDEX_FORMAT` is at 3: version 2
  added the `inferred` column (ADR-0021), version 3 added links and the facet-count fix.
- The budgets are the thing that keeps this honest. If a shard cannot be kept under 600 KB
  gzipped, the premise (download it all, filter locally) has expired and search has to move
  server-side.
- Writing the reader by hand means a format mistake is ours. The two-way parse test is the
  guard, and it earned its place: the query tests caught a pay filter that dropped ranges
  with only a minimum, because `Math.max` with `NaN` is `NaN`.
