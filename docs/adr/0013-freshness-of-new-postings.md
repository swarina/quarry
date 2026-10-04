# ADR-0013: Measure freshness only where it means something

- Status: accepted
- Date: 2026-09-28
- From: #12

## Context

How quickly Quarry sees a new posting is the one quality a job search tool is judged on that it
can measure about itself. Freshness here means how long after the publish time an ATS states we
first see a posting.

The naive version of this metric is badly wrong in two ways, both of which flatter or distort
it beyond use:

- **A board's first listing is all new to us.** Every posting on it, however long it has been
  published, looks like a posting we took weeks to find. With 499 boards onboarded over a few
  days, those would swamp every other number.
- **Lever does not state a publish time.** It states `createdAt`, which its own API docs do not
  define, and which can precede publication.

## Options

1. **Report the median delay over everything first seen today.** One query, and the number is
   dominated by board onboarding rather than by anything about the pipeline.
2. **Report nothing until the corpus settles.** Honest and gives up the measurement.
3. **Define what counts, and keep the caveats visible in the breakdown.**

## Decision

Option 3.

- **Only postings on boards we had listed before** are counted. Everything on a board's first
  listing is excluded.
- **A publish time ahead of our clock** counts as no delay rather than a negative one.
- **Lever's numbers are an upper bound**, because `createdAt` can precede publication, and the
  per-source rows keep that visible instead of blending it into one figure.
- A posting with no publish time is counted as seen but untimed, so coverage and delay are
  separate numbers.
- Percentiles are nearest-rank, so every reported value was actually observed rather than
  interpolated between two postings.

Each run reports median and 95th percentile for the postings it saw first, and over the last
seven days overall and per source, in the job summary and in `stats.json`.

## Consequences

- The number means something from the first day rather than after the corpus settles.
- Splitting by source is what makes the Lever caveat survive. A single blended median would
  quietly carry an unknown bias from a third of the corpus.
- Freshness depends on what the ATS states, so it measures our delay plus whatever the ATS's
  own timestamp means. It is not a claim about how quickly employers publish.
- Nearest-rank percentiles on small samples are coarse: with one posting, the median and the
  95th are that posting. The run summary shows the count beside them for exactly that reason.
- The query runs over `postings`, `boards`, and `board_crawls` with no schema change, so this is
  derived from observations like everything else (ADR-0016) and can be recomputed over history
  if the definition changes.
