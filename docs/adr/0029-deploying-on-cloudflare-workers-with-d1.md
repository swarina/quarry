# ADR-0029: Deploy on Cloudflare Workers, with D1 behind the criterion ports

- Status: accepted
- Date: 2026-10-06

## Context

Everything works except that no person can reach it: the search runs in the browser over a static
index, and the criterion path is a plain `(Request) => Response` handler (ADR-0027) that only
`serve-criteria` has ever run. Deploying means putting the static files somewhere, and giving the
handler's three ports (posting text, the answer cache, the daily budget) something that works on
the edge rather than on `node:sqlite`.

The limits that shape this were read from the Cloudflare docs on **2026-10-06** (the docs were
unreachable from the build environment until then, which is why this record is late and why the
date matters):

- **D1 database size:** 500 MB (Free) / 10 GB (Workers Paid). Storage per account 5 GB / 1 TB.
- **Bound parameters per query:** 100.
- **Queries per Worker invocation (read subrequest limit):** 50 (Free) / 1000 (Paid). The
  per-statement limits, including this one, apply to **each statement inside a `db.batch()`**,
  not to the batch as a whole.
- **SQL statement length:** 100,000 bytes. **Columns per table:** 100.

These are the current numbers, not ones to trust from memory; a future revisit should re-read the
page and re-date it.

## Options

**Where the static site lives, relative to the criterion path.** ADR-0028 already decided asking
is same-origin. Cloudflare offers two shapes for that: Pages (static hosting with Functions), or
a single Worker with Static Assets (`[assets]`), where one Worker both serves the files and runs
the dynamic routes. Cloudflare is folding Pages into Workers, and the Static Assets model is the
one that matches "one Worker, serving the page and the path from one origin" without a second
product.

**What backs the three ports.** D1 (managed SQLite) or R2 (object store). The posting text is
read by id-prefix range scan, the answer cache is read and written by key, and the budget is a
reserve-then-settle counter (ADR-0005). Those are all database operations, not blob fetches: R2
cannot range-scan by key, and the store is already SQLite, so the same SQL moves across almost
unchanged. R2 would only earn its place if posting text were too large for D1, which is a data
question, not a shape question.

## Decision

**A single Worker with Static Assets, D1 behind all three ports.**

- **One Worker serves both.** `[assets]` serves the built site; `run_worker_first` is set to the
  criterion routes only, so `/criteria/ask` and `/criteria/estimate` run the handler and every
  other path is a static file. The handler's responses are JSON, so they need no page headers;
  the page's own security headers come from the `_headers` file the build emits, which is the
  production form of ADR-0028's single-source policy.
- **D1 behind the ports.** A D1 adapter implements `PostingSource`, `AnswerCache`, and
  `BudgetStore` against `env.DB`, mirroring the `node:sqlite` adapter the pipeline already uses.
  The budget's reserve-then-settle stays one statement, as it is on `node:sqlite`.
- **The posting-text read is chunked, not one statement per prefix.** The handler resolves up to
  500 id prefixes. One range-scan statement per prefix would be up to 500 statements, which
  exceeds the Free plan's 50-subrequest limit (the limit counts each statement in a batch). So
  the adapter groups the prefixes into `substr(id, 1, n) IN (?, ...)` queries of at most 100
  parameters each, about five statements for a full page, which fits both plans. This keeps the
  adapter identical across plan tiers: only the data ceiling differs.
- **The client uses the global `fetch`.** The Jev client is portable by construction (the SDK is
  given a `fetch` transport and the client imports no `node:*`); only the file-backed ledger and
  cassette are Node-only, and they stay out of the Worker. Spend is still capped by the
  per-request spend limit and the D1 daily budget; a Worker ledger, if wanted, is a D1 table
  rather than a file.

## Consequences

- The store's posting text has to be loaded into D1 before the path works, and kept roughly in
  step with the crawl. That is a new operational step, and it is where the plan tier bites: the
  full corpus of ~35,000 postings with descriptions may not fit the Free plan's 500 MB, so a real
  deployment of the whole corpus likely wants Workers Paid, while a slice fits Free for trying it
  out. This is a cost decision for whoever deploys, not a code one.
- The adapter is written to the tightest limits (100 parameters, 50 subrequests), so it behaves
  the same on either plan. If a future page size above 500 postings is wanted, the chunking already
  generalizes, but the handler's own `MAX_POSTINGS` would be the thing to raise first.
- Search stays free to serve and needs no D1 at all: it is static files, and only the criterion
  path touches the database. A D1 outage degrades asking, not searching.
- The Worker lives in `apps/worker`: the entry, the D1 adapter for the three ports, the
  `wrangler.toml`, and the table schema. The adapter is tested in the repo against `node:sqlite`
  through a shim of the D1 API, and the whole Worker is verified under `wrangler dev` against a
  local D1 (the page serves with its policy, the estimate route resolves postings from D1 and
  prices them). Loading the Worker under `workerd` also showed the `@quarry/jev` import graph,
  the TypeSafe SDK included, resolves at the edge. The one thing a deploy proves for the first
  time is the ask route's real model call, which needs a funded key. `docs/DEPLOYMENT.md` carries
  the steps, and `pipeline export-criterion-data` writes the posting text into D1-loadable SQL.
- `wrangler dev` caught a real bug in the first `_headers`: a Cloudflare `_headers` rule allows
  only one `*`, so the two-wildcard cache rules (`/index/*/shards/*`) were silently skipped. The
  build now writes them with the build segment as a named placeholder (`/index/:build/shards/*`),
  which is the one-wildcard form, so the immutable caching actually applies.
