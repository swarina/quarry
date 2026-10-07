# Quarry

**Ask your own questions of every job posting.**

[![CI](https://github.com/swarina/quarry/actions/workflows/ci.yml/badge.svg)](https://github.com/swarina/quarry/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/Node-24-339933?logo=node.js&logoColor=white)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers%20%2B%20D1-F38020?logo=cloudflare&logoColor=white)

Job search tools extract a fixed set of fields from each posting, because running a language model
over every posting for every user's question is too slow and too expensive. Quarry takes the other
road. A daily pipeline crawls company job boards and answers a standard set of questions about every
posting with [Jev](https://docs.typesafe.ai/), a model that returns **typed values with calibrated
probabilities instead of generated text**. You search those answers in your browser over a static
index, and then **ask your own question of the postings a search leaves** (yes/no, pick-one, or a
graded scale), answered on demand and bounded by a budget. A wording is the question: an answer is
cached by question text, posting content, and model version, so the second person to ask the same
thing pays nothing.

## What it demonstrates

1. **Calibrated AI, not generated prose.** Jev returns a value and a probability, never a sentence a
   model wrote. The whole distribution is stored, not just the picked option, so "remote or hybrid,
   at least 70%" means something and a posting nothing has been asked about is never shown as a no.
   Jev returns no quotations or spans, so Quarry does not pretend to have them.
2. **Cost-bounded inference on demand.** A novel question is answered only for the page a search
   leaves (about $0.04 for 500 postings), under a per-request and a per-day cap that reserve before
   spending and settle after, so a bug is cheap per request and never ruinous per day.
3. **Search with no server.** The index is a static, content-addressed, columnar file; filtering
   (including by calibrated answers) runs entirely in the browser, and the whole search lives in the
   URL, so a search is shareable and the back button works, with no accounts and nothing logged.
4. **A pipeline that is polite and reproducible.** Boards are crawled one request at a time with
   conditional revalidation; each crawl is stored as an observation and the posting lifecycle is
   derived from it; the store ships as encrypted, drill-tested snapshots.

## Architecture

```mermaid
flowchart LR
  subgraph pipeline["daily pipeline (GitHub Actions)"]
    crawl["crawl<br/>Greenhouse · Lever · Ashby"]
    enrich["enrich<br/>standard questions → Jev"]
    build["build index<br/>+ encrypted snapshot"]
    crawl --> enrich --> build
  end

  index[("static index<br/>columnar, content-addressed")]
  build --> index

  subgraph worker["Cloudflare Worker (one origin)"]
    site["static site<br/>browser search"]
    criteria["criterion path<br/>/criteria/ask"]
  end

  d1[("D1<br/>posting text · answer cache · budget")]
  jev["Jev<br/>pinned model"]

  index --> site
  browser(["browser"]) -->|filter in-browser| site
  browser -->|your own question| criteria
  criteria --> d1
  criteria -->|only what the filters leave| jev
```

Search needs no server: it is static files the browser filters. Only the custom-question path spends,
and only it touches D1. The static site and that path are served from one origin so there is no CORS
on an endpoint that spends money. A criterion's answers are cached in D1, so a popular question over a
popular filter is paid for once for everyone.

## Design principles

*(Hard rules. Violating one is a bug, not a style choice.)*

- **Never guess an external API or its limits.** The model is pinned and every answer is validated
  against its schema before it is trusted; Jev's own option and length limits are enforced before a
  request is built. Cloudflare and Jev limits are read from the docs and dated in an ADR, not
  recalled from memory.
- **A wording is the question.** Answers are keyed on question text, posting content, and model
  version, so editing a word re-asks, a repost is free, and a model upgrade invalidates cleanly.
- **Reserve before spending, settle after.** An exact cap under concurrency needs an upper bound
  reserved before the call and reconciled to the real cost after, for both the per-request and the
  daily budget.
- **Not asked is not no.** A posting with no answer never matches a threshold filter, and an answer
  whose own best guess is weak is shown as "unsure" rather than silently dropped.
- **Politeness by construction.** robots.txt, one request at a time per host with a second between,
  conditional revalidation, and a one-day honored removal list, enforced in the client so a caller
  cannot forget.
- **The secret lives in memory only.** Asking is closed behind a shared secret that the page holds
  in memory and never writes to the URL or to storage; search stays public static files.

## Quickstart

Requires Node.js 24 and pnpm (via corepack).

```sh
pnpm install
pnpm check
```

Crawl a few boards into a local store (no credentials needed; a repeat crawl revalidates with
`304 Not Modified` and costs almost nothing):

```sh
pnpm pipeline crawl --store data/pipeline.sqlite --max-boards 20
pnpm pipeline index --store data/pipeline.sqlite --out data/index
```

Build and serve the search site:

```sh
pnpm --filter @quarry/site build --index data/index
pnpm --filter @quarry/site serve
```

That serves search alone. To also ask your own questions locally, serve the site beside the
criterion path so both share one origin (asking needs a secret and a `TYPESAFE_API_KEY`, and is
capped per request and per day):

```sh
QUARRY_CRITERIA_SECRET=$(openssl rand -base64 24) TYPESAFE_API_KEY=... \
  pnpm pipeline serve-criteria --store data/pipeline.sqlite --site apps/site/dist
```

## Deployment

The site and the criterion path deploy as a single Cloudflare Worker with a D1 database behind the
path, on Cloudflare's **free** plan (Workers Free and D1 Free), so there is no infrastructure cost;
the only cost is the Jev API when someone asks a genuinely new question, and that is capped. The
design and the dated limits that drove it are in
[ADR-0028](docs/adr/0028-the-secret-in-memory-and-one-origin.md) and
[ADR-0029](docs/adr/0029-deploying-on-cloudflare-workers-with-d1.md); the runnable steps are in
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Testing & CI

`pnpm check` is what CI runs: a typography check, Biome lint and format, three TypeScript project
builds, and the full Vitest suite with coverage. Architecture rules (which package may import what,
no `node:*` in portable code, no import cycles) are enforced by the linter, not by review. The daily
[pipeline workflow](.github/workflows/pipeline.yml) crawls, snapshots, and rebuilds the index; a
[restore drill](.github/workflows/restore-drill.yml) proves the snapshots are usable backups; a
[probe](.github/workflows/probe.yml) opens an issue if the schedule stops.

## Repository layout

```
apps/
  pipeline/   CLI: crawl, enrich, build the index, export D1 data, report on each run
  site/       the browser search over the static index (no server, no accounts)
  worker/     the Cloudflare Worker: site + criterion path over D1, one origin
packages/
  ats/        Greenhouse, Lever, Ashby board adapters, tested against recorded responses
  crawl/      a polite HTTP client: robots.txt, pacing, retries, conditional requests
  criteria/   asking your own questions: the criterion, its cache key, the budget, the handler
  domain/     pure shared logic: deterministic JSON and hashing, identity, posting text
  facets/     the standard facets derived from stated fields, and reading stored answers
  jev/        the single guarded entry to Jev: pinned model, validated answers, spend limits
  places/     a gazetteer built from GeoNames, and the reader that places a posting
  questions/  the standard questions, their versions, and the accuracy harness
  search-index/ building the static index, and reading and querying it in the browser
  storage/    the pipeline's SQLite store: schema, migrations, crawl observations, snapshots
docs/adr/     architecture decision records: what was decided, what else was on the table, the cost
seeds/        the boards to crawl, and boards removed at their company's request
```

## Limitations (by design, and honestly)

This is a learning-first project with a hard zero-recurring-cost constraint. The engineering is real;
the scope is deliberately bounded.

- **Asking is not public yet.** The custom-question path is closed behind a shared secret, so it is
  not shareable. Opening it needs per-IP quotas, a global cap, and a visible cost estimate first,
  which is a product to design once the cost model has been seen in real use.
- **Per-question accuracy is not measured yet.** The site groups answers into likely / maybe /
  unlikely bands, but the cuts are chosen by eye pending a hand-labelled golden set, and no accuracy
  figure is claimed until that exists.
- **500 postings and 5 criteria per request are judgements, not measurements.** The first real use
  should check whether a page of results is the unit people actually want to ask about.
- **One model, pinned.** Jev is new; the integration is pinned to a single model version, and a
  calibrated answer belongs to the model that produced it, so an upgrade re-asks rather than reusing.

## Data

Place names come from [GeoNames](https://www.geonames.org), licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); see
[`packages/places/data`](packages/places/data/README.md) for what is used and how it was changed.
Postings belong to the companies that published them: Quarry reads only the public board APIs those
companies expose for embedding, links to the employer's own page to apply, and never copies a
description.

## License

[MIT](LICENSE) © 2026 Swarina Jaiswal
