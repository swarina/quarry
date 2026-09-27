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
- **Honest uncertainty.** Results are grouped into likely, maybe, and unlikely, with
  published accuracy for every standard question.
- **Evidence, not generated claims.** Answers point back to the text of the posting.
- **Private by design.** No accounts, and resumes are processed in your browser.
- **Respectful sourcing.** Only public job board APIs that employers publish for embedding,
  crawled politely, with the employer's own page as the place to apply.

> **Status:** early development. In place: the Jev client (model pinning, response
> validation, spend limits, cost accounting) and a daily pipeline that crawls job boards
> politely, records what every crawl saw, and keeps encrypted snapshots of its store.
> Enrichment and the web application are next.

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

## Repository

| Path | Contents |
| --- | --- |
| [`apps/pipeline`](apps/pipeline) | The pipeline command line: crawls job boards into the pipeline store and reports on each run |
| [`packages/ats`](packages/ats) | Adapters for the Greenhouse, Lever, and Ashby job board APIs, with contract tests against recorded responses |
| [`packages/crawl`](packages/crawl) | A polite HTTP client: robots.txt, per-host pacing, retries, circuit breaking, and conditional requests |
| [`packages/domain`](packages/domain) | Pure logic shared by every runtime: deterministic JSON and hashing, board and posting identity, and posting text |
| [`packages/jev`](packages/jev) | The single entry point for Jev: pinned model, validated answers, spend limits, rate limiting, cost ledger, record and replay |
| [`packages/storage`](packages/storage) | The pipeline's SQLite store: schema, migrations, and crawl observations |
| [`seeds`](seeds) | The job boards to crawl, and the list of boards removed at their company's request |
| [`scripts`](scripts) | Repository tooling |

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

## Operations

The [Pipeline workflow](.github/workflows/pipeline.yml) runs once a day at 03:17 UTC:

1. **Crawl** (read-only token): restores the pipeline store from the newest snapshot in the
   `pipeline-store` release, crawls every active board, and packs an encrypted snapshot.
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
2. Run the Pipeline workflow manually with **bootstrap** checked. Scheduled runs take over
   from there.

To inspect production data locally, restore the newest snapshot (needs the key and a token
that can read the repository):

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

See [CONTRIBUTING.md](CONTRIBUTING.md) for scripts, conventions, and architecture rules, and
[SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## License

[MIT](LICENSE)
