# Deploying Quarry

Search is static files and runs anywhere. The criterion path (asking your own questions) is a
Cloudflare Worker with a D1 database behind its three ports, served from the same origin as the
site so there is no CORS on an endpoint that spends money (ADR-0028). The design and the Cloudflare
limits that shape it are in [ADR-0029](adr/0029-deploying-on-cloudflare-workers-with-d1.md).

It runs on Cloudflare's **free** plan, which needs no credit card: Workers Free (100,000
requests/day) and D1 Free (a 500 MB database, which the corpus of posting text fits). The only
cost is the Jev API when someone asks a genuinely new question, capped per request and per day.

The first deploy needs your Cloudflare account, your Jev key, and your store-encryption key, so
steps 1 to 3 are not something CI or a cloud session can do for you. Once that first deploy has
worked, step 4 hands the daily one to the pipeline. The steps use `npx wrangler`, which needs only
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

## 2. Get posting data, and build the index and the dump

The posting text lives in the private pipeline store. Restore the production snapshot if you have
the key (`QUARRY_STORE_KEY`, 32 bytes base64, and a token that can read the repo); each environment
variable and the command go on one line:

```sh
GH_TOKEN=$(gh auth token) GITHUB_REPOSITORY=swarina/quarry QUARRY_STORE_KEY='your-base64-key==' pnpm pipeline store pull --store data/pipeline.sqlite
```

No key, or you have never run the daily pipeline? Crawl a fresh store instead; crawling needs no
key and no secret:

```sh
pnpm pipeline crawl --store data/pipeline.sqlite --max-boards 20
```

Either way, your local checkout must be at least as new as the store's schema, so pull `main`
first if the store was made by the deployed pipeline (`git pull origin main && pnpm install`).
Then build the browser index and the D1 dump from the store:

```sh
pnpm pipeline index --store data/pipeline.sqlite --out data/index
pnpm pipeline export-criterion-data --store data/pipeline.sqlite --out data/criterion-postings.sql
```

Create the tables and load the dump into D1:

```sh
cd apps/worker
npx wrangler d1 execute quarry-criteria --remote --file=schema.sql
npx wrangler d1 execute quarry-criteria --remote --file=../../data/criterion-postings.sql
```

Re-run the export and the second load whenever you want the deployed path to see newer postings;
it is independent of the daily pipeline, which keeps the authoritative store. The answer cache and
the daily budget are written at runtime and need no loading.

## 3. Build the site, set the secrets, and deploy

```sh
# From the repo root: build the site the Worker serves (emits dist/ and dist/_headers). The
# --index path is resolved from where you run this, so data/index (built in step 2) is correct.
pnpm --filter @quarry/site build --index data/index

cd apps/worker
npx wrangler secret put QUARRY_CRITERIA_SECRET   # any string of at least 24 characters, you pick it
npx wrangler secret put TYPESAFE_API_KEY          # from console.typesafe.ai/keys
npx wrangler deploy
```

Open the `https://quarry-criteria.<you>.workers.dev` URL it prints. The per-request and per-day
spend caps live in `wrangler.toml` under `[vars]` (defaults $0.10 and $2.00); set them deliberately
before the first deploy, because they are the backstop against a bug spending your money.

## 4. Hand the daily deploy to CI

Once the deploy above has worked by hand, the daily pipeline can do it for you. The `deploy` job in
[`.github/workflows/pipeline.yml`](../.github/workflows/pipeline.yml) runs after the crawl,
downloads the search index that crawl built, builds the site around that index, and runs
`wrangler deploy` from `apps/worker`. The page and the index it was built against go up as one
Worker version, so the deployment cannot serve a page and an index that disagree.

It deploys only when all of these hold:

- the run is not a dry run, which crawls into a throwaway store and ships nothing,
- the crawl job succeeded end to end, which includes the 95% board health check, and
- the crawl job actually produced an index.

A crawl that only partly succeeded still has its store snapshotted, because the store accumulates
and the next run carries on from it. It is not deployed: a deploy replaces what the site already
shows, so a thin index would be a step backwards rather than a gap. A failed deploy raises the same
`pipeline-failure` issue as any other failed step, through the `report` job that is already there,
so there is no second alert to watch.

### The secrets it needs

The job reads two repository secrets. Add them under **Settings** > **Secrets and variables** >
**Actions** > **New repository secret**:

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Your account id, from the dashboard URL or from `npx wrangler whoami` |
| `CLOUDFLARE_API_TOKEN` | The token you create below |

Create the token at **dash.cloudflare.com** > **My Profile** > **API Tokens** > **Create Token** >
**Create Custom Token**, and give it exactly this:

- Permission `Account` / `Workers Scripts` / `Edit`. This is what uploads the Worker and its static
  assets.
- Permission `Account` / `D1` / `Edit`. The Worker binds the `quarry-criteria` database, and
  wrangler resolves that binding as it deploys.
- Account Resources: `Include` the one account that holds `quarry-criteria`, not all accounts.
- Zone Resources: none. The Worker is published on `workers.dev`, so it needs no zone and no
  `Workers Routes` permission. Add `Zone` / `Workers Routes` / `Edit`, for that one zone only, if
  you later move the site to a custom domain.
- TTL: your choice. An expired token fails the job loudly, and that failure opens the usual issue.

Cloudflare's own "Edit Cloudflare Workers" template is wider than this: it also carries
`Workers KV Storage`, `Workers R2 Storage`, `Workers Tail`, `Account Settings: Read` and
`User Memberships: Read`. This job needs none of them. It needs neither read permission because
`CLOUDFLARE_ACCOUNT_ID` is given explicitly, so wrangler never has to discover which account to
deploy into. Cloudflare does not publish a minimum set for a given Worker, so if a deploy ever
fails with an authorization error, the template is the fallback: start from it and take permissions
away until it breaks.

Treat the token as a deploy credential for your whole account. The job never prints it and GitHub
masks it in logs, but rotate it if it leaks, and delete it in the Cloudflare dashboard if you stop
using this repository.

### What CI still does not do

The deploy job ships the site and the Worker. It does not load posting text into D1: the
`export-criterion-data` and `wrangler d1 execute --remote` commands in step 2 stay manual, because
they rewrite the table the criterion path reads and they need the store key. Re-run them by hand
when you want the asking path to see newer postings.

The `wrangler` version in the workflow is pinned, like every action in it, because a deploy runs
third-party code with a token that can deploy. Bump it deliberately.

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
