import { type Continent, gazetteer } from "./gazetteer.ts";

/** A group of countries that labels name as one place: "EMEA", "Nordics", "Remote - EU". */
export interface Region {
  readonly name: string;
  readonly countries: readonly string[];
}

// Member states as listed at european-union.europa.eu (27, checked 2026-09-27).
const EU = [
  "AT",
  "BE",
  "BG",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GR",
  "HR",
  "HU",
].concat(["IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK"]);
const MIDDLE_EAST = ["AE", "BH", "CY", "EG", "IL", "IQ", "IR", "JO", "KW", "LB", "OM", "PS"].concat(
  ["QA", "SA", "SY", "TR", "YE"],
);
const NORTH_AFRICA = ["DZ", "EG", "LY", "MA", "SD", "TN"];
const CENTRAL_AMERICA = ["BZ", "CR", "GT", "HN", "NI", "PA", "SV"];
const SOUTHEAST_ASIA = ["BN", "ID", "KH", "LA", "MM", "MY", "PH", "SG", "TH", "TL", "VN"];
const GULF = ["AE", "BH", "KW", "OM", "QA", "SA"];

function continents(...codes: readonly Continent[]): string[] {
  return gazetteer()
    .countries.filter((country) => codes.includes(country.continent))
    .map((country) => country.code);
}

function without(codes: readonly string[], removed: readonly string[]): string[] {
  return codes.filter((code) => !removed.includes(code));
}

/**
 * Regions by the names labels use for them, folded. Continents come from GeoNames; business
 * regions (EMEA, APAC, LATAM) have no single definition, so these are the common ones.
 */
const DEFINITIONS: readonly (readonly [string, readonly string[], () => readonly string[]])[] = [
  ["Europe", ["europe"], () => continents("EU")],
  ["European Union", ["eu", "european union"], () => EU],
  ["European Economic Area", ["eea", "european economic area"], () => [...EU, "IS", "LI", "NO"]],
  ["EMEA", ["emea"], () => [...new Set([...continents("EU", "AF"), ...MIDDLE_EAST])]],
  [
    "Asia Pacific",
    ["apac", "asia pacific", "apj", "asia pacific and japan"],
    () => without(continents("AS", "OC"), MIDDLE_EAST),
  ],
  ["Asia", ["asia"], () => continents("AS")],
  ["Africa", ["africa"], () => continents("AF")],
  ["Oceania", ["oceania"], () => continents("OC")],
  ["North America", ["north america", "namer", "noram"], () => ["US", "CA", "MX"]],
  ["South America", ["south america"], () => continents("SA")],
  [
    "Latin America",
    ["latin america", "latam"],
    () => [...continents("SA"), "MX", ...CENTRAL_AMERICA, "CU", "DO", "PR"],
  ],
  ["Americas", ["americas", "the americas", "amer"], () => continents("NA", "SA")],
  [
    "Nordics",
    ["nordics", "nordic", "nordic countries", "scandinavia"],
    () => ["DK", "FI", "IS", "NO", "SE"],
  ],
  ["DACH", ["dach"], () => ["AT", "CH", "DE"]],
  ["Benelux", ["benelux"], () => ["BE", "LU", "NL"]],
  ["UK and Ireland", ["uki", "uk&i"], () => ["GB", "IE"]],
  ["Australia and New Zealand", ["anz"], () => ["AU", "NZ"]],
  ["Middle East", ["middle east"], () => MIDDLE_EAST],
  ["North Africa", ["north africa"], () => NORTH_AFRICA],
  ["Middle East and North Africa", ["mena"], () => [...new Set([...MIDDLE_EAST, ...NORTH_AFRICA])]],
  ["Gulf", ["gcc", "gulf", "gulf region"], () => GULF],
  ["Southeast Asia", ["southeast asia", "south east asia"], () => SOUTHEAST_ASIA],
];

let built: ReadonlyMap<string, Region> | undefined;

/** Regions by folded name. Every country code in them exists in the gazetteer. */
export function regionsByName(): ReadonlyMap<string, Region> {
  if (built === undefined) {
    const known = new Set(gazetteer().countries.map((country) => country.code));
    const regions = new Map<string, Region>();
    for (const [name, names, countries] of DEFINITIONS) {
      const region = {
        name,
        countries: [...new Set(countries())].filter((code) => known.has(code)),
      };
      for (const folded of names) regions.set(folded, region);
    }
    built = regions;
  }
  return built;
}
