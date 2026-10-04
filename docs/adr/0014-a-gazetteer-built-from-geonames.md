# ADR-0014: Build a gazetteer from GeoNames, filtered against real labels

- Status: accepted
- Date: 2026-09-28
- From: #15, #21

## Context

Reading a location label into a place needs a list of places. Job postings name cities,
regions, states, countries, and aliases in many languages, and often misspell them.

The obvious source is GeoNames (CC BY 4.0), which is comprehensive. Comprehensive is the
problem: it lists every alternate name anyone has recorded for a place, and those collide
catastrophically with ordinary words and with other places' names.

## Options

1. **A geocoding API.** Accurate and a per-request cost, a network dependency in a pure library,
   and it cannot run in the browser or a Worker.
2. **GeoNames, everything included.** Free and offline, and 3.8 MB, and it places postings
   wrongly in ways nobody would guess.
3. **GeoNames, filtered by rules derived from the corpus we actually have.**

## Decision

Option 3. A build script produces one JSON file: 250 countries with ISO codes, continent and
population, 3,865 first-level divisions, and 34,149 cities over 15,000 people or capitals. It is
2.9 MB of ASCII-escaped JSON, one record per line so a refresh reads as a diff, marked
`linguist-generated` and skipped by Biome.

The filtering rules came from running the first build against the 22,309 postings then in the
corpus. Keeping every Latin-script alternate name put "USA" on a town called Concord, "India" on
Inđija, and "Ireland" on West Springfield. An alternate name is kept only when it:

- is capitalized, which drops romanizations like "baeng-geollo";
- is not an all-caps code, which drops airport codes like "MUC";
- does not belong to another place. A country's name is kept only for its capital ("Kuwait" for
  Kuwait City), and a division's name only for a city inside it ("New York" for New York City,
  which real labels use 4,140 times).

Real labels still resolve through what remains: "Bangalore", "München", "Lisboa", "Warszawa",
"Tel Aviv-Yafo", "Frankfurt", "Cologne", "Milano", "Kiev", and the misspelling "San Fransisco"
(87 postings).

Later, #21 added a short list of smaller places by GeoNames id from the per-country dumps, for
places below the 15,000 cutoff that real postings name: King Abdullah Economic City (about
10,000 people, 49 postings) and Pangyo as a city alias. The build fails if one of them
disappears. The list stays short deliberately: small places collide with common words far more
often than cities do.

## Consequences

- No network dependency and no per-request cost, and the same data works in Node, a Worker, and
  the browser. The browser never loads it (ADR-0007), but it could.
- The filtering rules are tuned to one corpus. A corpus shifting to other regions could need
  them revisited, and the way to tell is the unplaced-labels report in each run summary.
- Dropping alternate names loses real recall somewhere. The golden set (ADR-0022) is what
  measures whether the trade is still right.
- A GeoNames refresh can remove places: the #21 download dropped Hollola, Tabuk in the
  Philippines, and Saminaka from `cities15000`. Pinning the small-places list by id and failing
  the build when one vanishes is what makes that visible rather than silent.
- Attribution is required by the licence and is in the README and in the data directory.
- The build reads the zip through its central directory with a CRC check, so there is no zip
  dependency for one file.
