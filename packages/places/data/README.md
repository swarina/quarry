# Gazetteer data

`gazetteer.json` is built by [`scripts/build-gazetteer.ts`](../scripts/build-gazetteer.ts)
from [GeoNames](https://www.geonames.org), which is licensed under
[Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/):

- `countryInfo.txt`: countries with their ISO codes, continent, and population.
- `admin1CodesASCII.txt`: first-level divisions (states, provinces, regions).
- `cities15000.zip`: cities with more than 15,000 people, and capitals.
- Per-country dumps such as `SA.zip`: the few smaller places job postings name, listed by
  GeoNames id in the build script's `EXTRA_CITIES`.

The file records when it was downloaded. Changes from the source:

- Only the fields Quarry uses are kept: codes, names, continent, population, and the
  division each city is in.
- Alternate city names are limited to capitalized names in Latin script that are not codes.
  A name that belongs to a country is kept only for that country's capital, and one that
  belongs to a division only for a city in that division.
- The withdrawn codes AN (Netherlands Antilles) and CS (Serbia and Montenegro) are removed,
  and division codes GeoNames doesn't define are cleared.
- Non-ASCII characters are written as JSON `\u` escapes.

To refresh it, run `pnpm --filter @quarry/places build-gazetteer` and review the diff.
