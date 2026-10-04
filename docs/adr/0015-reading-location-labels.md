# ADR-0015: Score location readings together, not token by token

- Status: accepted
- Date: 2026-09-28
- From: #16

## Context

A posting's location is a free-text label an employer typed. Real examples: "London", "Remote -
US", "Austin TX", "SF, NY, SEA", "Bergamo, BG, Italy", "Hybrid; In-Office", "NAMER", "Strava
SF", "Karkiv", "🇩🇪 Berlin".

Reading these needs decisions that cannot be made one token at a time, because the right answer
for a token depends on its neighbours:

- "Paris" is France, unless the label says "Paris, TX".
- "CA" is California next to "San Francisco" and Canada next to "Toronto".
- "BG" is Bulgaria alone and a Bergamo province code in "Bergamo, BG, Italy".
- "New York" is a state or a city depending on what else is there.

## Options

1. **Longest-match lookup per token.** Simple and fast, and it cannot use context at all, so
   every ambiguous token is a coin flip.
2. **Rules in priority order.** Handles the cases you thought of, and the rules interact as they
   accumulate, which is how a parser becomes unmaintainable.
3. **Score candidate readings and choose them together.** More machinery, and context falls out
   of the model instead of being special-cased.
4. **Ask a model.** Jev could answer this, and it would cost money per posting for something a
   gazetteer can do offline, and it would not be deterministic.

## Decision

Option 3. `readLabel(label, hints?)` returns places, a work arrangement, whether the label
allows working from anywhere, and the parts it could not place.

1. **Split** on `|`, `;`, `/`, and bullets into segments, then into pieces on commas, colons,
   spaced dashes, and brackets.
2. **Strip** arrangement words ("Remote -", "Hybrid", "Home based", "remoto"), noise ("HQ",
   "Office"), and numbers and street fragments. A piece that is not a name as a whole is split
   on and/&/or, or at the space that leaves most of it named ("Austin TX", "Strava SF").
3. **Candidates** per token from the gazetteer: country names in 17 languages from ICU, common
   aliases and ISO codes, regions (EMEA, Nordics, EU, LATAM), divisions with US, Canadian and
   Australian codes and some local names ("Bayern"), and cities with their alternate names.
4. **Choose together.** Only neighbouring tokens interact, so a Viterbi pass finds the best
   combination rather than an exhaustive search. The score sums each reading's own weight,
   context from other tokens (a country the label names or implies, then hinted countries from
   the posting's offices and addresses, then the company's home country), and how neighbours fit.

Five rules came from real labels rather than from first principles, and are worth keeping
listed: a city of 200,000 or more beats a division of the same name; a small foreign place next
to a named country is dropped; a country code next to a city in another country is a division
code; a short word in capitals is only ever a code; flag emoji are countries.

## Consequences

- Context is handled by the model, so "San Francisco, CA" beats "San Francisco, Canada" without
  a rule naming either.
- Measured on the 22,309 postings then in the corpus: 98.8% of Greenhouse, 99.1% of Ashby and
  100% of Lever postings placed, 98.5% of the 3,297 distinct labels naming a place, all of them
  in 250 ms.
- **Placed is not correct**, which is the honest caveat and the reason ADR-0022 exists. These
  numbers say the reader produced an answer, not that the answer was right.
- Viterbi over neighbouring tokens only is an assumption: it cannot use a token three pieces
  away. It holds for labels of the shape employers write, and a label that needed wider context
  would read wrongly without anything flagging it.
- The scoring weights are tuned by hand against one corpus, so they are a fit to today's data.
  The golden set is what stops a retune from quietly making things worse.
- What stays unmatched is mostly company names ("Jobs.cz", "Deliveroo") and places under 15,000
  people, which the run summary lists most-common-first so the next gap is visible.
