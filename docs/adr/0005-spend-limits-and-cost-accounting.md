# ADR-0005: Reserve an upper bound before spending, and ledger every call

- Status: accepted
- Date: 2026-09-26
- From: `ddb1984`, `f71b47f`

## Context

Enrichment is a long-running job that makes many concurrent requests against a budget. The
obvious way to respect a cap is to add up what has been billed and stop when the total
reaches it, but billing is only known after a response arrives. With requests in flight,
the sum of what is billed is always behind the sum of what is committed, so a cap checked
that way can be overshot by however much is outstanding.

The budget also has to survive the process. A run can be interrupted by a runner timeout or
a cancelled workflow, and the next run needs to know what the previous one already spent.

A third problem is arithmetic. Jev's input price is about $0.042 per million tokens, so a
single call costs a tiny fraction of a cent. Accumulating those in floating point across tens
of thousands of calls accumulates error in the one number that is supposed to be auditable.

## Options

1. **Count billed tokens and stop at the cap.** Simple, and overshoots by the work in
   flight, which is exactly the regime enrichment runs in.
2. **Serialize requests so nothing is ever in flight concurrently.** Makes the cap exact and
   throws away the parallelism that makes Jev worth using.
3. **Reserve an upper bound per request, then settle to the billed amount.** Exact as a cap,
   conservative in the middle, and needs a bound no token count can exceed.

## Decision

Option 3. The spend limit reserves an upper bound on each request's cost before the request
goes out, using the UTF-8 size of the payload, which no token count can exceed. When the
response arrives, the reservation settles to the billed tokens. Concurrent requests can
therefore never overshoot the cap, because every one of them has already reserved its worst
case.

Costs are integer nano-dollars, which keeps them exact. Every call, successful or not, is
written to a cost ledger: `createJsonlLedger` appends one validated JSON object per call to a
JSONL file. Appends are serialized, so entries stay whole and in order under concurrency, and
a failed write never blocks the entries queued behind it.

## Consequences

- The cap is a real cap under concurrency, which is the property that lets a run be given a
  budget and left alone.
- Reservations are pessimistic, so a run can stop short of its nominal budget. The gap is
  the ratio between payload bytes and actual tokens, and it is reported, not hidden: a
  refused spend is read as the budget speaking (ADR-0025).
- Nano-dollar integers mean no rounding drift across 35,000 calls, at the cost of converting
  at the display boundary.
- The ledger is append-only and survives the process, so budgets resume and spend is
  auditable against what `enrichment_runs` recorded.
- A ledger write failure does not stop the run. That is deliberate (a failed audit line
  should not cost a paid-for answer) and it means the ledger can have gaps, so the store's
  own run accounting is the cross-check.
