# Quarry

**Ask your own questions of every job posting.**

Job search tools extract a fixed set of fields from each posting, because running a language
model over every posting for every user's question is too slow and too expensive. Quarry
takes a different approach. You write the criteria that matter to you in plain language,
for example "Does this team own its infrastructure end to end?". Quarry answers them across
the whole market with [Jev](https://docs.typesafe.ai/), a model that returns typed answers
with calibrated probabilities instead of generated text.

- **Your questions, not a fixed schema.** Yes-or-no, pick-one, or graded-scale criteria,
  stacked and weighted however you like.
- **Honest uncertainty.** Results are grouped into likely, maybe, and unlikely, and an answer
  nothing has been asked yet is never shown as a no. Accuracy per standard question is not
  measured yet, and nothing here claims a number until it is.
- **Typed answers, not generated prose.** An answer is a value with a probability, never a
  sentence a model wrote, and the employer's own posting is one click away. Jev returns no
  quotations or spans to point at (ADR-0026), so Quarry does not pretend to have them.
- **Private by design.** No accounts, and resumes are processed in your browser.
- **Respectful sourcing.** Only public job board APIs that employers publish for embedding,
  crawled politely, with the employer's own page as the place to apply.

> **Status:** feature-complete, not yet deployed, so it is not reachable by a person yet. In
> place: the Jev client (model pinning, response validation, spend limits, cost accounting); a
> daily pipeline that crawls job boards politely, records what every crawl saw, and keeps
> encrypted snapshots of its store; enrichment, which answers the standard questions about every
> posting; a static search index carrying those answers; a browser search over it; and the
> criterion path, with the box on the site for writing your own question, behind a per-request
> and a daily budget. What is left is yours: deploying it, which runs on Cloudflare's free tier
> at no cost beyond the Jev API (see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)), and measuring
> per-question accuracy against a hand-labelled set.

## Design

Quarry is being built in four parts:

1. A scheduled pipeline collects postings from public applicant tracking system APIs
   (Greenhouse, Lever, Ashby) and tracks each posting's history.
2. Every new or changed posting is enriched with a versioned set of standard questions in a
   single Jev request.
3. Custom questions are answered on demand for the postings you're looking at. Each answer is
   cached by question, posting content, and model version, so the next person asking the same
   question pays nothing.
4. Search runs in your browser over a static index. Only genuinely new questions reach the API.

In deployment, the static site and the custom-question path are one Cloudflare Worker served from
a single origin, with a D1 database behind the path (posting text, the answer cache, and the daily
budget). Search needs no server; only the custom-question path touches D1, and only it spends. The
shape and the limits that drove it are in
[ADR-0028](docs/adr/0028-the-secret-in-memory-and-one-origin.md) and
[ADR-0029](docs/adr/0029-deploying-on-cloudflare-workers-with-d1.md); the steps are in
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Repository

| Path | Contents |
| --- | --- |
| [`apps/pipeline`](apps/pipeline) | The pipeline command line: crawls job boards, enriches postings, builds the search index, exports the deployment's posting data, and reports on each run |
| [`packages/ats`](packages/ats) | Adapters for the Greenhouse, Lever, and Ashby job board APIs, with contract tests against recorded responses |
| [`apps/site`](apps/site) | The search site: filters the static index in the browser, with no server and no account |
| [`apps/worker`](apps/worker) | The Cloudflare Worker: serves the static site and runs the custom-question path over D1, from one origin |
| [`packages/crawl`](packages/crawl) | A polite HTTP client: robots.txt, per-host pacing, retries, circuit breaking, and conditional requests |
| [`packages/criteria`](packages/criteria) | Asking your own questions: a criterion and its cache key, the budget it runs under, and the request handler |
| [`packages/domain`](packages/domain) | Pure logic shared by every runtime: deterministic JSON and hashing, board and posting identity, and posting text |
| [`packages/facets`](packages/facets) | A posting's standard facets: the ones derived from stated fields, and the reading of stored answers |
| [`packages/jev`](packages/jev) | The single entry point for Jev: pinned model, validated answers, spend limits, rate limiting, cost ledger, record and replay |
| [`packages/places`](packages/places) | A gazetteer built from GeoNames, and the reader that turns location labels into places |
| [`packages/questions`](packages/questions) | The standard questions, the versions their answers are stored under, and how accurate they are |
| [`packages/search-index`](packages/search-index) | The static index the site filters: building it, and reading and querying it in the browser |
| [`packages/storage`](packages/storage) | The pipeline's SQLite store: schema, migrations, and crawl observations |
| [`seeds`](seeds) | The job boards to crawl, and the list of boards removed at their company's request |
| [`scripts`](scripts) | Repository tooling |
| [`docs/adr`](docs/adr) | Architecture decision records: what was decided, what else was on the table, and what it costs |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | How to deploy on Cloudflare's free tier, and what needs your account |

## Development

Requires Node.js 24 and pnpm (via corepack).

```sh
pnpm install
pnpm check
```

To crawl a few boards into a local store (no credentials needed):

```sh
pnpm pipeline crawl --store data/pipeline.sqlite --max-boards 5
```

Run it again and unchanged boards answer `304 Not Modified`, so a repeat crawl costs almost
nothing.

To run the site, build it and serve it:

```sh
pnpm --filter @quarry/site build --index <dir>
pnpm --filter @quarry/site serve
```

That serves search alone, which needs no credentials and spends nothing. To also ask your own
questions, serve the same directory beside the criterion path instead, which puts both on one
origin (ADR-0028):

```sh
QUARRY_CRITERIA_SECRET=$(openssl rand -base64 24) TYPESAFE_API_KEY=... \
  pnpm pipeline serve-criteria --store data/pipeline.sqlite --site apps/site/dist
```

Asking spends money, so the page asks for that secret before it will send anything. It is kept
in memory for as long as the tab is open and written nowhere, so a reload asks for it again.
Each request is capped (`--per-request-usd`, default $0.10) and so is each UTC day
(`--per-day-usd`, default $2.00).

## Deployment

Search is static files; the criterion path is a Cloudflare Worker with a D1 database behind its
three ports, served from the same origin so there is no CORS on an endpoint that spends money
(ADR-0028, ADR-0029). It runs on Cloudflare's **free** plan, which costs nothing and needs no
card: Workers Free gives 100,000 requests a day, and D1 Free a 500 MB database, which the corpus
of posting text fits. The only cost is the Jev API when someone asks a genuinely new question,
and that is capped per request and per day. The runnable steps, and what still needs an account,
are in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). (Cloudflare limits checked 2026-10-06.)

## Operations

The [Pipeline workflow](.github/workflows/pipeline.yml) runs once a day at 03:17 UTC:

1. **Crawl** (read-only token): restores the pipeline store from the newest snapshot in the
   `pipeline-store` release, crawls every active board, and packs an encrypted snapshot. It then
   builds the search index from the postings boards list now (kept as the `search-index`
   artifact until the site serves it). The job summary reports crawl success per source;
   freshness, which is how long after their stated publish time new postings were first seen
   (median and 95th percentile, per run and over the last 7 days); and how many postings the
   index placed, with the budgets each shard is held to.
2. **Commit** (write token, no third-party code): uploads the snapshot, then its manifest.
   Manifest names are unique, so two runs can never commit the same snapshot number.
   Snapshots outside retention (14 daily, 12 weekly) are deleted.
3. **Report:** a failed scheduled run opens an issue labeled `pipeline-failure`, and the next
   successful run closes it. The [Probe workflow](.github/workflows/probe.yml) opens a
   `pipeline-stale` issue if no snapshot is committed for 30 hours.

Setup, once:

1. Create a 256-bit key, keep a copy in a password manager (snapshots can't be restored
   without it), and store it as the repository secret `QUARRY_STORE_KEY`:
   `openssl rand -base64 32`, then `gh secret set QUARRY_STORE_KEY`.
   Answering questions about postings also needs `TYPESAFE_API_KEY`
   ([console.typesafe.ai/keys](https://console.typesafe.ai/keys)), in `.env` locally and as a
   repository secret once the pipeline asks them; crawling and indexing need neither.
2. Run the Pipeline workflow manually with **bootstrap** checked. Scheduled runs take over
   from there.

A manual run with **dry-run** checked crawls into a throwaway store and saves nothing, so it
needs no key. It is the way to check the crawl from GitHub's runners, for example after changing
seeds or adapters; the job summary and a `crawl-stats` artifact show the results.

The [Restore drill workflow](.github/workflows/restore-drill.yml) proves the snapshots are
usable backups. Once a month it restores the oldest snapshot retention keeps onto a fresh
runner, checks it, and resumes from it: opening the store migrates it to the current schema,
and five boards are crawled on top of it. It commits nothing. A failed scheduled drill opens a
`restore-drill` issue, and the next successful drill closes it. A manual run can restore any
snapshot (`oldest`, `newest`, or its number).

To inspect production data locally, restore a snapshot (needs the key and a token that can
read the repository). `--snapshot` picks one other than the newest:

```sh
GH_TOKEN=$(gh auth token) GITHUB_REPOSITORY=swarina/quarry QUARRY_STORE_KEY=... \
  pnpm pipeline store pull --store data/restored.sqlite
pnpm pipeline store verify --store data/restored.sqlite
```

## Sources

Quarry reads only the public job board APIs that Greenhouse, Lever, and Ashby provide for
companies to embed their openings. The crawler identifies itself as `QuarryBot` with a
contact link, follows each host's robots.txt, sends one request at a time per host with at
least a second between requests, and revalidates unchanged boards with conditional requests.
A company can ask for its board to be excluded; removals are honored within a day through
[`seeds/denylist.yaml`](seeds/denylist.yaml).

Place names come from [GeoNames](https://www.geonames.org), licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); see
[`packages/places/data`](packages/places/data/README.md) for what is used and how it was changed.

See [CONTRIBUTING.md](CONTRIBUTING.md) for scripts, conventions, and architecture rules, and
[SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## License

[MIT](LICENSE)
