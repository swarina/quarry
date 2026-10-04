# ADR-0009: Fail a board when its listing cannot be trusted, never a job

- Status: accepted
- Date: 2026-09-27
- From: #3

## Context

Each ATS adapter maps a job board API response to `NormalizedPosting`. Things go wrong in two
very different ways, and treating them alike is a correctness bug either way round.

If a response is not a listing at all, or a job has no readable id, then nothing about the
listing can be trusted. The presence model (ADR-0016) reads a successful listing as evidence
about every posting on the board: absence from it closes a posting. So accepting a partial or
misread listing as successful would close jobs that are still open.

If one job among hundreds has an unexpected field, that is a gap in our parser. Treating it as a
failed listing would throw away the other 499 jobs; treating the job as absent would close it.

## Options

1. **Strict everywhere: any schema problem fails the board.** Safe against bad data, and one
   odd job takes out a whole company's postings, which in practice means the crawl breaks
   whenever an ATS adds a field.
2. **Lenient everywhere: skip what does not parse, keep the rest.** Resilient, and a parser gap
   silently closes real jobs, which is invisible and wrong.
3. **Strict where trust depends on it, lenient elsewhere.** Two rules to understand, and each
   failure mode gets the handling it deserves.

## Decision

Option 3.

- A response that is not a listing, or a job without a readable id, **fails the whole board**,
  because no job's presence on it could be trusted.
- Any other schema problem marks **only that job** as invalid, and it still counts as listed, so
  a gap in our parser can never close a posting.
- A listing containing invalid jobs does not keep its ETag, so the next run refetches it in full
  and picks those jobs up once the parser is fixed.
- Only structured facts are mapped: declared workplace, employment type, department, team,
  language, publish time, and salary ranges with a known currency and pay interval. Ashby jobs
  marked as not publicly listed are left out.
- `NORMALIZER_VERSION` versions the mapping, so a content-hash change caused by our code can be
  told apart from an employer's edit.

API facts were checked against the live endpoints on 2026-09-27: public GET endpoints, 404 for
an unknown board, and ETags with 304 responses to `If-None-Match` on all three.

## Consequences

- A parser gap costs coverage of one job and is reported, rather than costing a board or
  silently closing postings.
- Invalid jobs are logged and counted, so the gap is visible in the run summary instead of
  being absorbed.
- Review hardened one real hazard worth keeping on the record: value lookups go through `Map`s,
  because an API string such as `"constructor"` previously resolved to an `Object.prototype`
  property. A pay interval of `"constructor"` put a function into the salary, and hashing it
  would have failed the run.
- Two fallbacks also came from real data: Lever falls back to the primary location when
  `allLocations` is empty, and Greenhouse content that already contains tags is not decoded a
  second time.
- Measured on the live APIs at the time: 11,047 postings from 63 boards with zero invalid jobs.
  The leniency is insurance, not a routine path.
