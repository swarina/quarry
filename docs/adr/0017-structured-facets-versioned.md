# ADR-0017: Derive the facets that need no model, and version the rules

- Status: accepted
- Date: 2026-09-28
- From: #17

## Context

A posting arrives with a mixture of structured fields and free text. Some of what search needs
is already stated: a workplace field, an employment type string, a salary range, a department, a
publish time. Some needs reading (the location labels, ADR-0015). Some needs a model (the
standard questions, ADR-0024).

Asking Jev for what an ATS already states would be paying for a field we have. But the stated
fields are not clean either: employment type is free text in Lever, salary is stated per hour,
week, month or year, and the same value means different things across sources.

## Options

1. **Pass the stated fields through as they are.** Free, and search then has to understand four
   ATSs' vocabularies, in the browser.
2. **Ask the model for everything, including what is stated.** Uniform, and it pays for fields
   we already have and makes them probabilistic when they are facts.
3. **Derive a normalized facet from the stated fields, and ask the model only for what is not
   stated.**

## Decision

Option 3. `deriveFacets(posting, board)` returns the facets that need no Jev: location (from
`locatePosting`, plus the countries of its places without repeats), work arrangement, employment
types, pay, department, and publish time.

- **Employment types come from a mapping table**, not a guess. It covers every label the corpus
  used: Ashby's values, and Lever's free text where "Full Time/Part Time" is both types, "CDI" is
  full-time, "Fixed-term" and "CDD" are temporary, "Working Student" is part-time. Program and
  entity names ("Binance Accelerator Program", "International EOR") name **no** type rather
  than a guessed one.
- **Work arrangement prefers the ATS's own field** (Lever, Ashby) and falls back to what the
  labels say ("Remote - US").
- **Pay is annualized** in its own currency: a month counts as 12, a week as 52, a day as 260
  working days, an hour as 2,080. The period it was stated for is kept. Currencies are never
  converted, which belongs to a salary layer with a rate source and a date.
- **`STRUCTURED_FACETS_VERSION`** versions the rules, so an artifact built from them records
  which rules made it.

## Consequences

- Search gets one vocabulary rather than four, decided once at build time rather than in every
  browser.
- A mapping table is honest about its coverage: an unmapped label produces no type, and the next
  unmapped label is a visible gap rather than a wrong answer. The alternative, inferring from
  the string, would have turned "Binance Accelerator Program" into an internship.
- Annualizing with fixed divisors is an approximation. 2,080 hours is a full-time year, so an
  hourly rate for a part-time role annualizes too high. Keeping `statedPer` means the original
  is recoverable.
- Not converting currencies means pay filters and sorts work within one currency only, which the
  site states. One employer states a USD 88,000 to 130,000 range as monthly, almost certainly
  annual, and pay is kept as stated because catching that needs conversion to sanity-check
  against.
- The version is what makes a facet change traceable: #21 took it to 2 and #23 to 3, each time
  with a measured count of how many postings changed.
