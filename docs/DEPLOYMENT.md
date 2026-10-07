# Deploying Quarry

Search is static files and runs anywhere. The criterion path (asking your own questions) is a
Cloudflare Worker with a D1 database behind its three ports, served from the same origin as the
site so there is no CORS on an endpoint that spends money (ADR-0028). The design and the Cloudflare
limits that shape it are in [ADR-0029](adr/0029-deploying-on-cloudflare-workers-with-d1.md).

It runs on Cloudflare's **free** plan, which needs no credit card: Workers Free (100,000
requests/day) and D1 Free (a 500 MB database, which the corpus of posting text fits). The only
cost is the Jev API when someone asks a genuinely new question, capped per request and per day.

The steps below need your Cloudflare account, your Jev key, and your store-encryption key, so they
are not something CI or a cloud session can do for you. They use `npx wrangler`, which needs only
Node (no global install). The repo's build and data commands need pnpm (`corepack enable`, then
`pnpm install` once in your clone).

## What is already in place

- The Worker lives in [`apps/worker`](../apps/worker): `src/index.ts` (the entry), `src/d1.ts`
  (the D1 adapter for all three ports), `wrangler.toml`, and `schema.sql`. It is verified under
  `wrangler dev` against a local D1; the only part a deploy proves for the first time is the ask
  route's real model call, which needs your key.
- The request handler and the three ports (`PostingSource`, `AnswerCache`, `BudgetStore`) are the
  same ones `pipeline serve-criteria` runs locally, with Node implementations tested in the repo.
- The built site emits a `_headers` file carrying the security policy (ADR-0028), which the
  deployment applies to every page and asset.

## 1. Create the D1 database

```sh
cd apps/worker
npx wrangler login                    # authorizes wrangler against your Cloudflare account
npx wrangler d1 create quarry-criteria
```

Paste the `database_id` it prints into `apps/worker/wrangler.toml`, replacing
`REPLACE_WITH_YOUR_DATABASE_ID`.

## 2. Create the tables and load the posting text

The posting text lives in the private pipeline store. Restore it if you do not have it locally
(needs `QUARRY_STORE_KEY` and a token that can read the repo):

```sh
GH_TOKEN=$(gh auth token) GITHUB_REPOSITORY=swarina/quarry QUARRY_STORE_KEY=... \
  pnpm pipeline store pull --store data/pipeline.sqlite
```

Dump the columns the Worker reads (id, content hash, title, company, locations, and the
description as plain text) to SQL, create the tables, then load the dump:

```sh
pnpm pipeline export-criterion-data --store data/pipeline.sqlite --out data/criterion-postings.sql

cd apps/worker
npx wrangler d1 execute quarry-criteria --remote --file=schema.sql
npx wrangler d1 execute quarry-criteria --remote --file=../../data/criterion-postings.sql
```

Re-run the export and the second load whenever you want the deployed path to see newer postings;
it is independent of the daily pipeline, which keeps the authoritative store. The answer cache and
the daily budget are written at runtime and need no loading.

## 3. Build the site, set the secrets, and deploy

```sh
# From the repo root: build the site the Worker serves (emits dist/ and dist/_headers).
pnpm --filter @quarry/site build --index <index dir>

cd apps/worker
npx wrangler secret put QUARRY_CRITERIA_SECRET   # any string of at least 24 characters, you pick it
npx wrangler secret put TYPESAFE_API_KEY          # from console.typesafe.ai/keys
npx wrangler deploy
```

Open the `https://quarry-criteria.<you>.workers.dev` URL it prints. The per-request and per-day
spend caps live in `wrangler.toml` under `[vars]` (defaults $0.10 and $2.00); set them deliberately
before the first deploy, because they are the backstop against a bug spending your money.

## Trying it locally first

`wrangler dev` runs the whole thing against a local D1, with no account and no spend, which is the
way to see it work before deploying:

```sh
cd apps/worker
printf 'QUARRY_CRITERIA_SECRET=a-local-dev-secret-of-32-characters\nTYPESAFE_API_KEY=unused-for-estimate\n' > .dev.vars
npx wrangler d1 execute quarry-criteria --local --file=schema.sql
npx wrangler d1 execute quarry-criteria --local --file=../../data/criterion-postings.sql
npx wrangler dev
```

`POST /criteria/estimate` with the bearer secret spends nothing and proves the path end to end;
`POST /criteria/ask` makes the real model call and needs a funded `TYPESAFE_API_KEY`. (`.dev.vars`
is gitignored.)

## Checking it

- Search works with no D1 and no secret; only the criterion path touches the database.
- Anyone the site is shown to can search but cannot ask: the path is closed behind the shared
  secret (ADR-0027, ADR-0028), which the page asks for and holds in memory only.
- A public version, open without a secret, needs per-IP quotas, a global cap, and a visible cost
  estimate first (ADR-0027). It is a product to design once the cost model has been seen in use.
