# ADR-0016: Store what each crawl saw, and derive the lifecycle from it

- Status: accepted
- Date: 2026-09-27
- From: #5
- Cited from: `packages/storage/src/node/migrations.ts`, `packages/domain/src/board.ts`

## Context

A job board API has no concept of a closed job. A posting is in today's listing or it is not,
and the only thing a crawler ever learns is which postings a particular fetch returned. Whether
a job closed, was reposted, or was simply missing from one short listing is an inference, not a
fact the API states.

Those inferences are also the ones most likely to be wrong early and need changing: how many
missed listings mean closed, whether a 404 run closes a board's postings, what a failed crawl
implies. If the store holds conclusions, every rule change loses the history that would let the
new rule be applied to it.

There is a size constraint too. Writing one row per posting per crawl is 35,000 rows a day,
which is 12 million a year for a store that has to fit in a free-tier release asset.

## Options

1. **Store the conclusion: a `status` column per posting, updated each crawl.** Smallest and
   simplest to query, and the rule is baked in. Changing it means re-deriving from data that no
   longer exists, so in practice it means never changing it. No way to audit why a posting was
   closed.
2. **Store one row per posting per crawl.** Complete and replayable, and it grows without bound
   for a store that must stay small.
3. **Store runs of presence, and derive the lifecycle on read.** Replayable, about one row per
   posting rather than one per day, and the lifecycle costs a query instead of a column read.

## Decision

Option 3. The store holds facts, not conclusions.

- Every fetch of a board is a `board_crawls` row with its outcome (`listed`, `not-modified`,
  `failed`, `not-found`, `board-gone`), so what was attempted and what happened is on the
  record.
- `posting_presence` keeps, per posting, runs of consecutive successful crawls that listed it.
  A posting present every day is one row, not one per day.
- Whether a posting is closed or reopened is derived from these, so the rule can change and be
  replayed over the full history, and every closure can be audited against the observations
  behind it.
- Crawl ids are `AUTOINCREMENT` and never reused, because the lifecycle orders by them.
- A board declared gone after 3 consecutive 404s spanning at least 48 hours closes its open
  postings. Both parts matter: the count stops one bad response, and the span stops one bad
  hour.

## Consequences

- The lifecycle rule is cheap to change, which it was: ADR-0005's index originally took only
  the latest listing, and widening it to "seen in one of the last two listings" was a change to
  one query, applied retroactively to every posting already stored.
- A 304 extends the presence of everything in the previous listing, so revalidation is not
  mistaken for absence. A known posting whose job fails validation stays present, so a gap in
  our parser can never close a posting.
- Reads pay for the derivation. The index build runs a window function over `board_crawls` on
  every build rather than reading a column.
- Presence runs are harder to reason about than a status column, and the tests carry that
  weight: presence across gaps, content changes including a revert, invalid jobs, 304s,
  failures, and board-gone timing are all pinned.
- Storing observations is what makes the store worth keeping at all. It is a record of what the
  job market looked like each day, which a status column would have thrown away.
