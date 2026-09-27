import { type City, gazetteer } from "./gazetteer.ts";
import { type Region, regionsByName } from "./regions.ts";
import { foldName } from "./text.ts";

/** What a name or code in a label can refer to. */
export type NameMatch =
  | { readonly kind: "country"; readonly country: string; readonly by: "name" | "code" }
  | { readonly kind: "region"; readonly region: Region }
  | {
      readonly kind: "division";
      readonly country: string;
      readonly division: string;
      readonly by: "name" | "code";
    }
  | { readonly kind: "city"; readonly city: City };

export interface NameIndex {
  /** Everything a folded name can refer to. */
  byName(folded: string): readonly NameMatch[];
  /** Everything a code written in capitals ("CA", "USA", "NYC") can refer to. */
  byCode(code: string): readonly NameMatch[];
}

/** Languages whose country names labels are likely to use (all written in Latin script). */
const LOCALES = [
  "en",
  "de",
  "fr",
  "es",
  "pt",
  "it",
  "nl",
  "pl",
  "sv",
  "da",
  "nb",
  "fi",
  "cs",
].concat(["ro", "hu", "tr", "id"]);

/** Common names ICU and GeoNames don't give, folded. */
const COUNTRY_ALIASES: ReadonlyMap<string, readonly string[]> = new Map([
  ["US", ["usa", "us", "u s", "u s a", "united states of america", "the united states", "the us"]],
  ["GB", ["uk", "u k", "great britain", "britain", "the uk", "the united kingdom"]],
  ["AE", ["uae", "u a e", "emirates"]],
  ["SA", ["ksa", "saudi"]],
  ["NL", ["holland", "the netherlands"]],
  ["KR", ["korea", "republic of korea"]],
  ["CZ", ["czech republic"]],
  ["TR", ["turkey", "turkiye"]],
  ["HK", ["hong kong sar", "hong kong s a r"]],
  ["MO", ["macau", "macao sar"]],
  ["PH", ["the philippines"]],
  ["CI", ["ivory coast"]],
  ["CV", ["cabo verde"]],
  ["VN", ["viet nam"]],
  ["MK", ["macedonia"]],
  ["PS", ["palestine"]],
  ["RU", ["russian federation"]],
  ["IE", ["republic of ireland"]],
]);

/** Local names of divisions that GeoNames gives only in English, folded, to the English name. */
const DIVISION_ALIASES: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map([
  [
    "DE",
    new Map([
      ["bayern", "Bavaria"],
      ["sachsen", "Saxony"],
      ["niedersachsen", "Lower Saxony"],
      ["nordrhein westfalen", "North Rhine-Westphalia"],
      ["hessen", "Hesse"],
      ["rheinland pfalz", "Rhineland-Palatinate"],
      ["thuringen", "Thuringia"],
      ["sachsen anhalt", "Saxony-Anhalt"],
      ["mecklenburg vorpommern", "Mecklenburg-Western Pomerania"],
    ]),
  ],
  [
    "PL",
    new Map([
      ["masovian voivodeship", "Mazovia"],
      ["mazowieckie", "Mazovia"],
      ["pomeranian voivodeship", "Pomerania"],
      ["pomorskie", "Pomerania"],
      ["lesser poland voivodeship", "Lesser Poland"],
      ["malopolskie", "Lesser Poland"],
      ["lower silesian voivodeship", "Lower Silesia"],
      ["dolnoslaskie", "Lower Silesia"],
      ["greater poland voivodeship", "Greater Poland"],
      ["wielkopolskie", "Greater Poland"],
      ["silesian voivodeship", "Silesia"],
      ["slaskie", "Silesia"],
    ]),
  ],
]);

/** Division codes that labels write after a city ("Toronto, ON"), mapped to division names. */
const DIVISION_CODES: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map([
  [
    "CA",
    new Map([
      ["AB", "Alberta"],
      ["BC", "British Columbia"],
      ["MB", "Manitoba"],
      ["NB", "New Brunswick"],
      ["NL", "Newfoundland and Labrador"],
      ["NS", "Nova Scotia"],
      ["NT", "Northwest Territories"],
      ["NU", "Nunavut"],
      ["ON", "Ontario"],
      ["PE", "Prince Edward Island"],
      ["QC", "Quebec"],
      ["SK", "Saskatchewan"],
      ["YT", "Yukon"],
    ]),
  ],
  [
    "AU",
    new Map([
      ["ACT", "Australian Capital Territory"],
      ["NSW", "New South Wales"],
      ["NT", "Northern Territory"],
      ["QLD", "Queensland"],
      ["SA", "South Australia"],
      ["TAS", "Tasmania"],
      ["VIC", "Victoria"],
      ["WA", "Western Australia"],
    ]),
  ],
]);

/** Nicknames and abbreviations for cities, to the city's name and country. */
const CITY_ALIASES: readonly (readonly [readonly string[], string, string])[] = [
  [["NYC"], "New York City", "US"],
  [["SF", "bay area", "sf bay area", "san francisco bay area"], "San Francisco", "US"],
  [["LA"], "Los Angeles", "US"],
  [["DC", "washington dc", "dc"], "Washington", "US"],
  [["TLV"], "Tel Aviv", "IL"],
  [["SEA"], "Seattle", "US"],
  [["CHI"], "Chicago", "US"],
  [["ATL"], "Atlanta", "US"],
  [["BOS"], "Boston", "US"],
  [["KL"], "Kuala Lumpur", "MY"],
  [["CDMX"], "Mexico City", "MX"],
  [["greater london"], "London", "GB"],
  [["greater boston"], "Boston", "US"],
  [["GTA", "greater toronto area"], "Toronto", "CA"],
  [["metro manila"], "Manila", "PH"],
];

/** Endings and beginnings that divisions carry in some names but not others. */
const DIVISION_AFFIXES = [
  /^(state|province|region|land|city) of /,
  / (state|province|prefecture|region|oblast|county)$/,
];

let built: NameIndex | undefined;

/** The index of every name and code, built on first use (a few hundred milliseconds). */
export function nameIndex(): NameIndex {
  built ??= buildIndex();
  return built;
}

function buildIndex(): NameIndex {
  const { countries, divisions, cities } = gazetteer();
  const names = new Map<string, NameMatch[]>();
  const codes = new Map<string, NameMatch[]>();
  const add = (map: Map<string, NameMatch[]>, key: string, match: NameMatch) => {
    if (key.length === 0) return;
    const list = map.get(key);
    if (list === undefined) map.set(key, [match]);
    else if (!list.some((known) => sameMatch(known, match))) list.push(match);
  };

  for (const country of countries) {
    const byName = { kind: "country", country: country.code, by: "name" } as const;
    add(names, foldName(country.name), byName);
    for (const locale of LOCALES) {
      for (const style of ["long", "short"] as const) {
        const display = new Intl.DisplayNames([locale], { type: "region", style }).of(country.code);
        if (display === undefined || display === country.code) continue;
        add(names, foldName(display), byName);
        // "Myanmar (Burma)": both names.
        for (const part of display.split(/[()]/)) add(names, foldName(part), byName);
      }
    }
    for (const alias of COUNTRY_ALIASES.get(country.code) ?? []) add(names, alias, byName);
    add(codes, country.code, { kind: "country", country: country.code, by: "code" });
    add(codes, country.iso3, { kind: "country", country: country.code, by: "code" });
  }

  for (const [folded, region] of regionsByName()) add(names, folded, { kind: "region", region });

  const divisionsByName = new Map<string, { country: string; code: string }>();
  for (const division of divisions) {
    const match = {
      kind: "division",
      country: division.country,
      division: division.code,
      by: "name",
    } as const;
    const folded = foldName(division.name);
    add(names, folded, match);
    for (const affix of DIVISION_AFFIXES) add(names, folded.replace(affix, ""), match);
    divisionsByName.set(`${division.country}:${folded}`, division);
    // US divisions are coded by their postal abbreviations ("CA", "NY").
    if (division.country === "US" && /^[A-Z]{2}$/.test(division.code)) {
      add(codes, division.code, { ...match, by: "code" });
    }
  }
  for (const [country, aliases] of DIVISION_ALIASES) {
    for (const [alias, name] of aliases) {
      const division = divisionsByName.get(`${country}:${foldName(name)}`);
      if (division !== undefined) {
        add(names, alias, { kind: "division", country, division: division.code, by: "name" });
      }
    }
  }
  for (const [country, abbreviations] of DIVISION_CODES) {
    for (const [code, name] of abbreviations) {
      const division = divisionsByName.get(`${country}:${foldName(name)}`);
      if (division === undefined) continue;
      add(codes, code, { kind: "division", country, division: division.code, by: "code" });
    }
  }

  const citiesByName = new Map<string, City>();
  for (const city of cities) {
    const match = { kind: "city", city } as const;
    for (const name of [city.name, ...city.alternates]) {
      const folded = foldName(name);
      add(names, folded, match);
      const known = citiesByName.get(`${city.country}:${folded}`);
      if (known === undefined || known.population < city.population) {
        citiesByName.set(`${city.country}:${folded}`, city);
      }
    }
  }
  for (const [aliases, name, country] of CITY_ALIASES) {
    const city = citiesByName.get(`${country}:${foldName(name)}`);
    if (city === undefined) continue;
    for (const alias of aliases) {
      if (/^[A-Z]+$/.test(alias)) add(codes, alias, { kind: "city", city });
      else add(names, alias, { kind: "city", city });
    }
  }

  return {
    byName: (folded) => names.get(folded) ?? [],
    byCode: (code) => codes.get(code) ?? [],
  };
}

function sameMatch(left: NameMatch, right: NameMatch): boolean {
  switch (left.kind) {
    case "country":
      return right.kind === "country" && right.country === left.country;
    case "region":
      return right.kind === "region" && right.region === left.region;
    case "division":
      return (
        right.kind === "division" &&
        right.country === left.country &&
        right.division === left.division
      );
    case "city":
      return right.kind === "city" && right.city.id === left.city.id;
  }
}
