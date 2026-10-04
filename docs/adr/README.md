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

**This backfill is partial.** 0001 to 0007, 0016, 0018, 0019 and 0026 are written, so every
citation above now resolves. The decisions listed as "to be written" below are recorded today
only in their commit messages and pull request descriptions, which remain the authoritative
source until a record exists.

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
| 0008 | Record and replay API exchanges instead of mocking the SDK | 2026-09-26 | `8784a62`, to be written |
| 0009 | Fail a board when its listing cannot be trusted, never a job | 2026-09-27 | #3, to be written |
| 0010 | Plain SQL on `node:sqlite`, with forward-only migrations | 2026-09-27 | #5, to be written |
| 0011 | Split the daily run into a read-only job and a writing job | 2026-09-27 | #8, to be written |
| 0012 | Drill the oldest snapshot, and probe for a schedule that stopped | 2026-09-28 | #13, to be written |
| 0013 | Measure freshness only where it means something | 2026-09-28 | #12, to be written |
| 0014 | Build a gazetteer from GeoNames, filtered against real labels | 2026-09-28 | #15, #21, to be written |
| 0015 | Score location readings together, not token by token | 2026-09-28 | #16, to be written |
| [0016](0016-crawls-recorded-as-observations.md) | Store what each crawl saw, and derive the lifecycle from it | 2026-09-27 | #5 |
| 0017 | Derive the facets that need no model, and version the rules | 2026-09-28 | #17, to be written |
| [0018](0018-politeness-by-construction.md) | Make politeness impossible for a caller to forget | 2026-09-27 | #4 |
| [0019](0019-declined-ny-as-a-city-alias.md) | Declined: do not read `NY` as New York City | 2026-10-02 | #28 |
| 0020 | Leave templates and test postings out of the index | 2026-09-28 | #22, to be written |
| 0021 | Place hybrid and headquarters postings in the company's country | 2026-09-28 | #23, to be written |
| 0022 | Hold the reader to hand-labelled answers, with floors below today | 2026-10-04 | #29, to be written |
| 0023 | No server and no accounts, with the search in the URL | 2026-10-01 | #27, to be written |
| 0024 | A wording is the question, and answers are keyed on content | 2026-10-04 | #30, to be written |
| 0025 | One request per posting, and four named ways for a run to stop | 2026-10-04 | #30, to be written |
| [0026](0026-jev-returns-no-evidence-spans.md) | Jev returns no evidence spans, so stop promising them | 2026-10-04 | this branch |

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
