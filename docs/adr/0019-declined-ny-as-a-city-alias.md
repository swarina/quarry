# ADR-0019: Declined: do not read `NY` as New York City

- Status: accepted
- Date: 2026-10-02
- From: #28
- Cited from: the commit message of #28

## Context

The location golden set found a label the reader gets wrong. "SF, NY, SEA" is three cities, and
the reader places San Francisco and Seattle but loses New York, because `NY` resolves to the
state of New York rather than the city. A label listing three city codes plainly means the city.

The obvious fix is to add `NY` as an alias for New York City, the way `CHI` already resolves to
Chicago and `SF` to San Francisco.

## Options

1. **Add `NY` as a city alias.** Fixes "SF, NY, SEA" and every label like it.
2. **Leave it, and record why.**
3. **Make the alias conditional on context**, for example only when every other token in the
   label is also a city code.

## Decision

Option 2, on the measurement. Across the 34,851 postings of the crawl at the time:

| | Postings |
| --- | ---: |
| Helped by the alias ("SF, NY, SEA" and similar) | 2 |
| Harmed by it ("Brooklyn, NY", "Rochester, NY" and similar) | 79 |

`NY` after a city name is the state, and that is overwhelmingly how it appears. Adding the alias
would put New York City into every posting labelled "Brooklyn, NY" or "Rochester, NY", which is
a worse error than the one being fixed and forty times more common.

Option 3 was not taken either, for now. A rule like "a code is a city when its neighbours are
all city codes" is plausible and would need its own measurement against the same corpus; it is
a narrower claim than the reader's existing scoring already makes, and the two could interact.
It is worth trying when there is reason to, not as part of fixing something else.

## Consequences

- "SF, NY, SEA" and labels like it keep the wrong answer for New York. Two postings today.
- The golden set records both rows as disagreements rather than as the reader's correct
  behaviour, so the cost stays visible instead of being argued away.
- The general shape of this decision is worth remembering: an alias that fires on a short
  ambiguous token is cheap to add and expensive to get wrong, because it applies to every label
  that happens to contain the token. The reader's other codes (`SF`, `CHI`, `SEA`) survive the
  same test because nothing else common uses them.
- If the corpus shifts so that city-code lists become common, the measurement changes and this
  should be revisited. The numbers above are the thing to recompute, not the conclusion.
