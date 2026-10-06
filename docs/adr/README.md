# Architecture decision records

One short file per significant decision: the context it was made in, the options that were
on the table, what was decided, and what that costs us. A record is written when a decision
is made and is not edited afterwards, except to mark it superseded by a later one. If we
change our mind, the new record says so and links back.

## Why these were written late

The decisions below were made between 2026-09-26 and 2026-10-04 and were recorded in commit
messages and pull request descriptions at the time, but never as records here. Five of them
were already cited by number from the source:

| Citation | Cited from |
| --- | --- |
| [ADR-0006](0006-encrypted-store-snapshots-in-releases.md) | `packages/storage/src/node/snapshot.ts`, `packages/storage/src/node/database.ts`, `apps/pipeline/src/retention.ts`, `apps/pipeline/src/releases.ts` |
| [ADR-0007](0007-search-in-the-browser-over-a-static-index.md) | `packages/search-index/src/format.ts`, `packages/search-index/src/build.ts`, `apps/site/src/catalog.ts`, `apps/site/src/format.ts` |
| [ADR-0016](0016-crawls-recorded-as-observations.md) | `packages/storage/src/node/migrations.ts`, `packages/domain/src/board.ts` |
| [ADR-0018](0018-politeness-by-construction.md) | `packages/crawl/src/fetcher.ts` |
| [ADR-0019](0019-declined-ny-as-a-city-alias.md) | the commit message of #28 |

Those five keep the numbers the source already uses. The rest were numbered when the records
were written, so **the sequence is not chronological** and the numbers carry no meaning beyond
identity. Each record states the change it came from, which is the authoritative date.

The backfill is complete: every decision below has a record, and every ADR cited from the source
resolves.

## The records

| # | Decision | Date | From |
| ---: | --- | --- | --- |
| [0001](0001-workspace-and-enforced-architecture-rules.md) | Enforce the architecture rules in the linter, not in review | 2026-09-26 | `68350f4` |
| [0002](0002-deterministic-serialization-and-hashing.md) | One deterministic serialization for cache keys and change detection | 2026-09-26 | `d4cfd32` |
| [0003](0003-board-and-posting-identity.md) | Derive identity from the board and job id, and hash only content | 2026-09-27 | #2 |
| [0004](0004-one-guarded-entry-point-to-jev.md) | Pin the model and validate every answer | 2026-09-26 | `ddb1984` |
| [0005](0005-spend-limits-and-cost-accounting.md) | Reserve an upper bound before spending, and ledger every call | 2026-09-26 | `ddb1984`, `f71b47f` |
| [0006](0006-encrypted-store-snapshots-in-releases.md) | Keep the store as encrypted snapshots on a GitHub release | 2026-09-27 | #7 |
| [0007](0007-search-in-the-browser-over-a-static-index.md) | Filter a static columnar index in the browser | 2026-09-28 | #18, #26 |
| [0008](0008-record-and-replay-jev-exchanges.md) | Record and replay API exchanges instead of mocking the SDK | 2026-09-26 | `8784a62` |
| [0009](0009-ats-adapters-strict-where-trust-depends-on-it.md) | Fail a board when its listing cannot be trusted, never a job | 2026-09-27 | #3 |
| [0010](0010-pipeline-store-on-node-sqlite.md) | Plain SQL on `node:sqlite`, with forward-only migrations | 2026-09-27 | #5 |
| [0011](0011-daily-pipeline-on-github-actions.md) | Split the daily run into a read-only job and a writing job | 2026-09-27 | #8 |
| [0012](0012-restore-drills-and-staleness-probes.md) | Drill the oldest snapshot, and probe for a schedule that stopped | 2026-09-28 | #13 |
| [0013](0013-freshness-of-new-postings.md) | Measure freshness only where it means something | 2026-09-28 | #12 |
| [0014](0014-a-gazetteer-built-from-geonames.md) | Build a gazetteer from GeoNames, filtered against real labels | 2026-09-28 | #15, #21 |
| [0015](0015-reading-location-labels.md) | Score location readings together, not token by token | 2026-09-28 | #16 |
| [0016](0016-crawls-recorded-as-observations.md) | Store what each crawl saw, and derive the lifecycle from it | 2026-09-27 | #5 |
| [0017](0017-structured-facets-versioned.md) | Derive the facets that need no model, and version the rules | 2026-09-28 | #17 |
| [0018](0018-politeness-by-construction.md) | Make politeness impossible for a caller to forget | 2026-09-27 | #4 |
| [0019](0019-declined-ny-as-a-city-alias.md) | Declined: do not read `NY` as New York City | 2026-10-02 | #28 |
| [0020](0020-placeholder-postings-left-out-of-the-index.md) | Leave templates and test postings out of the index | 2026-09-28 | #22 |
| [0021](0021-home-country-as-a-last-resort.md) | Place hybrid and headquarters postings in the company's country | 2026-09-28 | #23 |
| [0022](0022-a-golden-set-for-the-location-reader.md) | Hold the reader to hand-labelled answers, with floors below today | 2026-10-04 | #29 |
| [0023](0023-the-site-no-server-no-accounts.md) | No server and no accounts, with the search in the URL | 2026-10-01 | #27 |
| [0024](0024-a-versioned-question-registry-keyed-on-content.md) | A wording is the question, and answers are keyed on content | 2026-10-04 | #30 |
| [0025](0025-one-request-per-posting-and-how-a-run-stops.md) | One request per posting, and four named ways for a run to stop | 2026-10-04 | #30 |
| [0026](0026-jev-returns-no-evidence-spans.md) | Jev returns no evidence spans, so stop promising them | 2026-10-04 | this branch |
| [0027](0027-ask-only-what-the-filters-leave.md) | Ask your own questions of the postings a search left | 2026-10-06 | this branch |

## Template

```markdown
# ADR-NNNN: A short title in the imperative

- Status: proposed | accepted | superseded by ADR-NNNN
- Date: YYYY-MM-DD
- From: the pull request or commit that carried it

## Context

What forced a decision. Include the numbers that mattered.

## Options

What was on the table, and the trade-off each one made.

## Decision

What we chose, stated plainly.

## Consequences

What this costs, what it rules out, and what would make us revisit it.
```
