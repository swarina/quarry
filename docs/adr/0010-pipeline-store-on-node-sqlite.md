# ADR-0010: Plain SQL on `node:sqlite`, with forward-only migrations

- Status: accepted
- Date: 2026-09-27
- From: #5

## Context

The pipeline needs a system of record for crawl observations: a few hundred thousand rows
growing daily, queried by the index build and the enrichment stage, living on an ephemeral
runner and shipped between runs as a file (ADR-0006).

A file is the requirement that decides most of this. The store has to be one artifact that can
be copied, hashed, encrypted, and restored, which rules out anything with a server.

## Options

1. **A hosted database.** Someone else's problem to run, and it is not a file, so ADR-0006's
   snapshot model does not apply, and the free tier does not cover a store this size.
2. **SQLite through `better-sqlite3`.** Mature and widely used, and a native module to build
   and keep working across Node upgrades.
3. **SQLite through `node:sqlite`**, the built-in. No dependency and no native build, and it
   printed an experimental warning on Node 24 at the time.
4. **An ORM over either.** Less SQL to write, and another layer between the schema and what
   actually runs, for a schema whose queries are the interesting part.

## Decision

Option 3, with plain SQL and no ORM. The experimental warning is one line per run, and the
module becomes a release candidate in the next LTS line, which is the direction of travel.

- **Migrations are forward-only**, tracked with `PRAGMA user_version`, each in its own
  transaction. A store written by newer code is refused rather than misread, because a
  half-understood store is worse than no store.
- **`STRICT` tables with foreign keys**, so a type error is a write failure rather than a
  surprise on read. `WITHOUT ROWID` only for small-row tables as SQLite recommends; postings and
  their contents are ordinary rowid tables.
- Crawl ids use `AUTOINCREMENT` and are never reused, because the lifecycle orders by them
  (ADR-0016).
- **Writes use the stored board state**, read inside the transaction, never the record a caller
  read earlier.
- **One transaction per board crawl**, so an interrupted run keeps every board it finished.

## Consequences

- No native module, no build step, no dependency to track against Node upgrades.
- The queries are visible SQL, which matters because the lifecycle derivation is the design.
  Widening "current" from one listing to two was a window function in one query.
- Refusing a newer schema means a rolled-back deployment cannot read the store a newer one
  wrote. That is the intended trade: it fails rather than misreads.
- The experimental warning appears in every log, and the API could change. It is pinned by
  `.node-version`, so an upgrade is a deliberate step, and the migration tests are what would
  catch a behaviour change.
- One transaction per board means a run that dies mid-crawl leaves a consistent store with
  fewer boards, not a corrupt one.
