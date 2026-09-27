import data from "../data/gazetteer.json" with { type: "json" };

/** Continents as GeoNames codes them. */
export type Continent = "AF" | "AN" | "AS" | "EU" | "NA" | "OC" | "SA";

export interface Country {
  /** ISO 3166-1 alpha-2. */
  readonly code: string;
  /** ISO 3166-1 alpha-3. */
  readonly iso3: string;
  readonly name: string;
  readonly continent: Continent;
  readonly population: number;
}

/** A first-level division: a state, province, region, or similar. */
export interface Division {
  readonly country: string;
  /** GeoNames' code within the country: postal codes for US states ("CA"), else FIPS or ISO. */
  readonly code: string;
  readonly name: string;
}

export interface City {
  /** The GeoNames id. */
  readonly id: number;
  readonly name: string;
  readonly country: string;
  /** The division's code, or an empty string when GeoNames has none. */
  readonly division: string;
  readonly population: number;
  /** Other names people write for it: exonyms, local names, common spellings. */
  readonly alternates: readonly string[];
}

export interface Gazetteer {
  /** Attribution for the data, which its license (CC BY 4.0) requires. */
  readonly source: string;
  /** When the data was downloaded, as YYYY-MM-DD. */
  readonly retrieved: string;
  readonly countries: readonly Country[];
  readonly divisions: readonly Division[];
  readonly cities: readonly City[];
}

type Row = readonly (string | number | readonly string[])[];

let decoded: Gazetteer | undefined;

/**
 * Countries, divisions, and cities from GeoNames (`data/gazetteer.json`, built by
 * `scripts/build-gazetteer.ts`), decoded on first use.
 */
export function gazetteer(): Gazetteer {
  decoded ??= {
    source: data.source,
    retrieved: data.retrieved,
    countries: (data.countries as readonly Row[]).map(
      ([code, iso3, name, continent, population]) => ({
        code: String(code),
        iso3: String(iso3),
        name: String(name),
        continent: String(continent) as Continent,
        population: Number(population),
      }),
    ),
    divisions: (data.admin1 as readonly Row[]).map(([country, code, name]) => ({
      country: String(country),
      code: String(code),
      name: String(name),
    })),
    cities: (data.cities as readonly Row[]).map(
      ([id, name, country, division, population, alternates]) => ({
        id: Number(id),
        name: String(name),
        country: String(country),
        division: String(division),
        population: Number(population),
        alternates: Array.isArray(alternates) ? alternates.map(String) : [],
      }),
    ),
  };
  return decoded;
}
