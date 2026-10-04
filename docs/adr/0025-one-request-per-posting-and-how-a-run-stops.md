# ADR-0025: One request per posting, and four named ways for a run to stop

- Status: accepted
- Date: 2026-10-04
- From: #30

## Context

Enrichment asks four questions about 35,000 postings against a budget, on a runner that can be
cancelled. Two things needed deciding, and both were measured in the Phase 0 experiments rather
than reasoned about.

**What goes in a request.** Jev prices input tokens, and the posting's text dominates the
request while the questions are a few tokens each. That suggests two savings: pack several
postings into one request, and trim boilerplate from the description.

**When a run stops.** A long job against a budget can stop for several reasons, and a run that
stopped early for one reason looks exactly like a finished one unless it says otherwise.

## Options and what the measurements said

Both savings were tried and both were rejected on the numbers, measured 2026-10-01:

| Option | Saving | Cost |
| --- | ---: | --- |
| Pack ten postings per request | 13% | changed one arrangement answer in ten, always toward "onsite" |
| Trim boilerplate from the description | 9% | changed one decision in forty |

Packing shifts answers systematically, which is worse than a random error: it biases the corpus
in one direction, so it would look like a finding about the job market. Trimming fails because
arrangement and sponsorship are often stated exactly in the parts that look like boilerplate.

Nine percent of $3 is not worth a biased corpus.

## Decision

**One request per posting, with every question in it, and the whole description sent.** Extra
questions are nearly free because the text is shared and is the expensive part, so the request
packs questions rather than postings.

**Four ways to stop, each named in the report** so a short run is never mistaken for a finished
one: the run's spend budget, its deadline, a posting limit, and five consecutive failures, which
say the problem is not this posting. A refused spend from the spend limiter is read as the
budget speaking rather than as an error.

Every request passes the spend limit, the rate limiter, and the ledger (ADR-0004, ADR-0005), and
`enrichment_runs` records what each run cost, so spend is auditable against the ledger file from
two independent records.

`--dry-run` spends nothing and reports what is outstanding and what it would cost, estimated
over the text that would actually be sent.

Measured on the 34,851 postings of that day's crawl: $3.03 to answer all of them, about
$0.000087 each. A verification run of 30 postings cost $0.002673 with no failures.

## Consequences

- Adding a fifth standard question costs a few tokens per posting rather than another pass, so
  the registry can grow cheaply. Rewording an existing one costs a full re-run (ADR-0024).
- One request per posting means 35,000 requests, which is why the rate limiter and the
  concurrency bound exist rather than being optional.
- Naming the stop reason is what makes a partial run safe to resume: the next run asks for
  whatever is still unanswered, so a budget-limited run is progress rather than a failure.
- Five consecutive failures as a signal assumes failures are independent per posting. A
  service-wide outage trips it quickly, which is the intent; a run of unusually long postings
  all failing a limit would also trip it, and that would read as an outage.
- The measurements are of one model version at one date. A model upgrade (ADR-0004) invalidates
  the cached answers anyway, and should re-run the packing and trimming comparisons rather than
  inherit these conclusions.
