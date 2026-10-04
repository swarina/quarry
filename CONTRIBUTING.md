# Contributing

## Prerequisites

- Node.js 24 (see `.node-version`).
- pnpm, pinned in `package.json`. Either run `corepack enable` once, or prefix commands
  with `corepack` (for example `corepack pnpm install`).

## Setup

```sh
pnpm install
cp .env.example .env   # only needed for live Jev calls
pnpm check             # typography, lint, typecheck, and tests with coverage
```

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm check` | Everything CI runs, in order |
| `pnpm lint` | Biome lint, formatting, import order, and architecture rules |
| `pnpm format` | Apply Biome formatting and safe fixes |
| `pnpm typecheck` | TypeScript in strict mode |
| `pnpm test` | Vitest |
| `pnpm test:coverage` | Vitest with coverage thresholds (as CI runs it) |
| `pnpm check:text` | Rejects forbidden typography in tracked files |
| `pnpm pipeline <command>` | The pipeline command line; `pnpm pipeline help` lists commands and options |
| `pnpm --filter @quarry/ats record-fixtures` | Re-records the ATS contract-test fixtures from the live APIs |

## Repository layout

| Path | Contents |
| --- | --- |
| `apps/pipeline` | The pipeline command line (Node.js only) |
| `packages/ats` | Job board API adapters: listing URLs, response schemas, and mapping to normalized postings |
| `packages/crawl` | The polite HTTP client every crawl request goes through |
| `packages/facets` | Standard facets of a posting: location, arrangement, employment type, and pay from structured fields and labels (Jev-answered facets come later) |
| `packages/domain` | Pure logic shared by every runtime: canonical JSON and hashing, board and posting identity, the normalized posting, and HTML-to-text |
| `packages/jev` | The only code that calls TypeSafe: pinned model, validated answers, spend limits, rate limiting, cost ledger, record and replay |
| `packages/places` | Reading location labels into places, with a gazetteer built from GeoNames (`data/`, refreshed by a script) |
| `packages/search-index` | The static search index: columnar shards by region and their manifest (built in the pipeline through `./build`), and the queries the browser runs over them |
| `packages/storage` | The pipeline's SQLite store (Node.js only, under `src/node/`) |
| `seeds` | `boards.yaml` (boards to crawl) and `denylist.yaml` (boards removed on request) |
| `scripts` | Repository tooling |

Internal packages export TypeScript source directly; there is no build step.

## Architecture rules

These are enforced by Biome, so `pnpm lint` fails when one is broken:

- No import cycles.
- Every import is declared in the nearest `package.json`. Library code may not import
  development dependencies.
- Library code runs in Node.js and Cloudflare Workers. Node built-ins are only allowed
  under `src/node/`.
- Only `packages/jev` may import `@typesafe-ai/sdk`.
- Apps may use Node built-ins. Environment variables are read in one place per app
  (`apps/pipeline/src/config.ts`).
- Production code never imports test files.

## Conventions

- **TypeScript:**
  - Strict mode with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
  - No `any`: a suppression must carry a written reason.
  - Named exports only.
- **Validation:** validate at every boundary with zod (API responses, files, configuration).
- **Units:**
  - Money is integer nano-dollars.
  - Time is epoch milliseconds.
  - Durations carry their unit in the name (`timeoutMs`).
- **Tests:**
  - Tests sit next to the code as `*.test.ts`.
  - They are deterministic: clocks and timers are injected or faked, and there are no live network calls.
- **Commits:**
  - Commits follow [Conventional Commits](https://www.conventionalcommits.org/) with a
    package scope, for example `feat(jev): record API exchanges for replay`.
  - Keep each commit to one logical change.
- **Pull requests:**
  - All checks must pass.
  - Changes are squash-merged.
  - Every pull request states its resource impact.
- **Typography:** no em dashes anywhere; use commas, colons, parentheses, or separate sentences.

## Adding a job board

1. Find the board's slug in its public URL, for example `job-boards.greenhouse.io/<slug>`,
   `jobs.lever.co/<slug>`, `jobs.eu.lever.co/<slug>` (Lever's EU instance, source `lever-eu`),
   or `jobs.ashbyhq.com/<slug>`.
2. Check that its listing API returns jobs, for example
   `https://boards-api.greenhouse.io/v1/boards/<slug>/jobs`,
   `https://api.lever.co/v0/postings/<slug>?mode=json`,
   `https://api.eu.lever.co/v0/postings/<slug>?mode=json`, or
   `https://api.ashbyhq.com/posting-api/job-board/<slug>`.
3. Check that the board belongs to the company you expect: a slug like `sunday` or `volta` can
   belong to an unrelated company with the same name. The job descriptions usually say.
4. Add one line to `seeds/boards.yaml`. CI validates the file, including duplicates.
