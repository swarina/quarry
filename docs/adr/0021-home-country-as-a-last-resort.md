# ADR-0021: Place hybrid and headquarters postings in the company's country

- Status: accepted
- Date: 2026-09-28
- From: #23

## Context

About 90 postings in the corpus said only "Hybrid" or "Headquarters" about where the work is,
and nothing else. The reader placed them nowhere, so they were invisible to every place filter,
even though somebody doing the job works at one of the company's offices.

The seed list records each board's company home country. For a posting that says it requires
office attendance and names no office, that country is the best available guess.

It is a guess, though, and guessing wrong is worse than not guessing: a posting shown in the
wrong country wastes a candidate's attention and quietly misrepresents the employer.

## Options

1. **Leave them unplaced.** Honest and makes 90 real jobs unfindable by place.
2. **Place every unplaced posting in the company's home country.** Finds them and places remote
   jobs wrongly, since a remote job is often open outside the home country.
3. **Place only those whose own text says the work is at an office, and mark them as
   inferred.**

## Decision

Option 3. When nothing else places a posting, it goes to its board's country at country level
with basis `home`, but only if the arrangement (the ATS's stated field first, then the labels)
is hybrid or on-site, or a label is a bare headquarters reference.

It stays unplaced when:

- anything says remote, checked in the raw text too, because the reader turns "Hybrid or
  Remote" into hybrid;
- the job is open to anywhere;
- any label or structured field names neither an arrangement nor headquarters ("Multiple
  locations"), or holds text the reader could not match ("APJC", "Parloa Inc."), since the real
  place may be in it.

The search index marks these places as inferred: shards gained an `inferred` column, the format
went to 2, and query results carry the flag so the site can show it. The run summary reports the
inferred share.

Measured across the 35,241 postings of the crawl at the time: exactly 87 changed placement,
PayPay's 79 "Hybrid" postings to Japan and Bitvavo's 8 "Headquarters" postings to the
Netherlands. Placement went from 99.0% to 99.2% and the index grew about 2 KB gzipped.

## Consequences

- 87 real jobs became findable by place, and the site shows them as inferred rather than as
  stated, so the guess is visible to the person reading it.
- The guards are the whole design. "Remote-only stays unplaced" is the one that matters most:
  it is the case where the home country is most likely wrong and most tempting to fill in.
- A wrong home country in the seed list now misplaces postings rather than merely failing to
  hint. The seed file says so, and that raises the cost of a careless entry.
- Carrying `inferred` through the format to the query to the UI is three layers for one bit, and
  worth it: an inferred place that looked identical to a stated one would be a quiet lie.
- The rule depends on an arrangement being stated. A posting saying only "Headquarters" with no
  arrangement is caught by the headquarters clause; one saying nothing at all stays unplaced,
  correctly.
