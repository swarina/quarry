# Deploying Quarry

Search is static files and runs anywhere. The criterion path (asking your own questions) is a
Cloudflare Worker with a D1 database behind its three ports, served from the same origin as the
site so there is no CORS on an endpoint that spends money (ADR-0028). The design and the current
Cloudflare limits that shape it are in [ADR-0029](adr/0029-deploying-on-cloudflare-workers-with-d1.md).

This file is the runnable steps. It assumes a Cloudflare account and the `wrangler` CLI
(`pnpm dlx wrangler` works without installing it). Everything here needs your account and, for
the full corpus, a paid plan, so it is not something CI or a cloud session can do for you.

## What is already in place

- The request handler is a plain `(Request) => Response` (`@quarry/criteria`), with everything
  environment-shaped behind three ports: `PostingSource`, `AnswerCache`, `BudgetStore`.
- Those ports have Node implementations (`@quarry/criteria/node`) used by `pipeline serve-criteria`,
  which runs the exact production request shape locally against a real store.
- The built site emits a `_headers` file carrying the security policy (ADR-0028), which a Workers
  static-assets deployment applies to every page and asset.

## What is left to do, and who does it

1. **A Worker** that wires the handler to D1 and serves the static site. Specified in ADR-0029;
   not yet written, because it can only be proven against a real D1. See "The Worker" below.
2. **A D1 database**, created in your account, loaded with the store's posting text.
3. **Deploy**, with the two secrets set.

## 1. Decide the plan tier

The whole corpus is about 35,000 postings with descriptions. The Free plan's D1 database limit is
500 MB (checked 2026-10-06); the full corpus with descriptions may not fit, so the full product
likely wants **Workers Paid** (10 GB). A **slice** of the corpus fits Free comfortably and is the
way to try the path end to end before paying. The Worker code is identical either way (ADR-0029);
only how much data you load differs.

## 2. Create the D1 database

```sh
pnpm dlx wrangler d1 create quarry-criteria
```

Copy the `database_id` it prints into the Worker's `wrangler.toml` (see below).

## 3. Load the posting text into D1

The posting text lives in the private pipeline store (`node:sqlite`). The Worker reads three
things from D1: posting text (by id prefix), the criterion answer cache, and the daily budget
counter. Only the posting text needs loading; the other two are written at runtime.

Export the columns the `PostingSource` needs (`id`, `content_hash`, `company`, and the normalized
JSON carrying title, description, and locations) from a restored store, as SQL, then apply it:

```sh
# Restore a store first if you do not have one locally (needs QUARRY_STORE_KEY and a read token):
#   GH_TOKEN=$(gh auth token) GITHUB_REPOSITORY=swarina/quarry QUARRY_STORE_KEY=... \
#     pnpm pipeline store pull --store data/pipeline.sqlite

# Then dump the posting-text rows to SQL and load them into D1. The exact dump command ships
# with the Worker (step 4); conceptually it writes a criterion_postings table and INSERTs.
pnpm dlx wrangler d1 execute quarry-criteria --remote --file=data/criterion-postings.sql
```

Re-run this whenever you want the deployed path to see newer postings; it is independent of the
daily pipeline, which keeps the authoritative store.

## 4. The Worker

Not yet written. ADR-0029 specifies it exactly:

- `wrangler.toml` with `main`, a `compatibility_date`, a `[[d1_databases]]` binding named `DB`
  with your `database_id`, an `[assets]` block (`directory = "./dist"`, `binding = "ASSETS"`),
  and `run_worker_first = ["/criteria/ask", "/criteria/estimate"]` so only those routes run the
  Worker and everything else is served as a static file.
- `src/index.ts`: a `fetch(request, env)` that calls `createCriteriaHandler` with a D1 adapter for
  the three ports (`env.DB`), the Jev client built on the global `fetch` with a per-request spend
  limit set to the allowance, `QUARRY_CRITERIA_SECRET` from `env`, and `JEV_MODEL`.
- A D1 adapter implementing the ports against `env.DB`, resolving id prefixes with chunked
  `substr(id, 1, n) IN (?, ...)` queries of at most 100 parameters each (ADR-0029 explains why
  per-prefix queries would exceed the Free plan's 50-subrequest limit).

This is a good piece to build against a local D1 with `wrangler dev` (its local mode simulates D1
with no network), seeding a few postings and driving `/criteria/estimate`, which spends nothing.

## 5. Set the secrets and deploy

```sh
pnpm dlx wrangler secret put QUARRY_CRITERIA_SECRET   # at least 24 characters
pnpm dlx wrangler secret put TYPESAFE_API_KEY          # from console.typesafe.ai/keys

pnpm --filter @quarry/site build --index <index dir>   # emits dist/ and dist/_headers
pnpm dlx wrangler deploy
```

The per-request and per-day spend caps are set in the Worker (the local defaults are $0.10 and
$2.00); choose them deliberately before the first deploy, because they are the backstop against a
bug spending your money.

## Checking it

- Search works with no D1 and no secret; only the criterion path touches the database.
- Anyone the site is shown to can search but cannot ask: the path is closed behind the shared
  secret (ADR-0027, ADR-0028), which the page asks for and holds in memory only.
- A public version, open without a secret, needs per-IP quotas, a global cap, and a visible cost
  estimate first (ADR-0027). It is a product to design once the cost model has been seen in use.
