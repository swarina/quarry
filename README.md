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

> **Status:** early development. The foundations are in place: the Jev client with model
> pinning, response validation, spend limits, and cost accounting. Data ingestion and the
> web application are next.

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
| [`packages/domain`](packages/domain) | Deterministic JSON and content hashing, shared by every runtime |
| [`packages/jev`](packages/jev) | The single entry point for Jev: pinned model, validated answers, spend limits, rate limiting, cost ledger, record and replay |
| [`scripts`](scripts) | Repository tooling |

## Development

Requires Node.js 24 and pnpm (via corepack).

```sh
pnpm install
pnpm check
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for scripts, conventions, and architecture rules, and
[SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## License

[MIT](LICENSE)
