import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { gazetteer } from "./gazetteer.ts";
import { locatePosting } from "./locate.ts";
import { regionsByName } from "./regions.ts";
import { foldName } from "./text.ts";

/**
 * How well the reader places real location labels, against 150 of them answered by hand
 * (`fixtures/location-golden.csv`, sampled by `experiments/04-location-golden.ts`: 100 weighted
 * by how often a label shape occurs, 50 from the long tail).
 *
 * This is a floor, not a target. It exists so that accuracy cannot quietly fall: a change that
 * makes the reader worse fails here, and a change that makes it better is free to raise the
 * floor. The disagreements it prints are the interesting output, so a failure says which labels
 * moved rather than only that a number dropped.
 */
const GOLDEN = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "fixtures",
  "location-golden.csv",
);

interface Row {
  readonly id: string;
  readonly stratum: string;
  readonly uses: string;
  readonly home: string;
  readonly stated: string;
  readonly label: string;
  readonly countries: string;
  readonly cities: string;
  readonly notes: string;
}

/** RFC 4180 fields: quoted fields may hold commas, doubled quotes, and line breaks. */
function parseCsv(text: string): Row[] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else field += character;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ",") {
      record.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else field += character;
  }
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  const [header = [], ...rest] = records;
  return rest
    .filter((values) => values.length === header.length)
    .map(
      (values) =>
        Object.fromEntries(header.map((name, at) => [name, values[at] ?? ""])) as unknown as Row,
    );
}

/** The answer column: country codes, or `@region` for a named region, or `-` for nowhere. */
function expectedCountries(cell: string): Set<string> {
  const regions = regionsByName();
  const countries = new Set<string>();
  for (const token of cell.trim().split(/\s+/)) {
    if (token === "" || token === "-") continue;
    if (token.startsWith("@")) {
      const region = regions.get(foldName(token.slice(1)));
      if (region === undefined) throw new Error(`the answers name an unknown region: ${token}`);
      for (const country of region.countries) countries.add(country);
    } else countries.add(token.toUpperCase());
  }
  return countries;
}

const rows = parseCsv(readFileSync(GOLDEN, "utf8")).filter((row) => row.countries !== "");
const cityNames = new Map(
  gazetteer().cities.map((city) => [
    city.id,
    new Set([city.name, ...city.alternates].map(foldName)),
  ]),
);

interface Scored {
  readonly row: Row;
  readonly found: Set<string>;
  readonly expected: Set<string>;
  readonly countriesRight: boolean;
  /** Undefined when the answer names no city, so the row says nothing about cities. */
  readonly citiesRight: boolean | undefined;
}

const scored: Scored[] = rows.map((row) => {
  const stated = row.stated.split(" | ").filter((part) => part !== "");
  const country = stated.find((part) => part.startsWith("country "))?.slice(8) ?? null;
  const places = stated
    .filter((part) => !part.startsWith("country "))
    .map((text) => ({ label: null, text }));
  const located = locatePosting(
    { locations: [row.label], places, country, workplace: null },
    row.home === "" ? null : row.home,
  );
  const found = new Set(located.places.map((place) => place.country));
  const expected = expectedCountries(row.countries);
  const wantedCities = row.cities
    .split("|")
    .map(foldName)
    .filter((name) => name !== "");
  const foundCities = located.places.flatMap((place) => (place.city === null ? [] : [place.city]));
  return {
    row,
    found,
    expected,
    countriesRight: found.size === expected.size && [...found].every((code) => expected.has(code)),
    citiesRight:
      wantedCities.length === 0
        ? undefined
        : wantedCities.every((name) => foundCities.some((id) => cityNames.get(id)?.has(name))) &&
          foundCities.length === wantedCities.length,
  };
});

const share = (right: number, total: number) => (total === 0 ? 1 : right / total);
const listed = (values: Set<string>) => [...values].sort().join(" ") || "nowhere";
const disagreements = scored
  .filter((result) => !result.countriesRight || result.citiesRight === false)
  .map(
    (result) =>
      `#${result.row.id} "${result.row.label.slice(0, 60)}": read ${listed(result.found)}, answered ${listed(result.expected)}${result.row.notes === "" ? "" : ` (${result.row.notes})`}`,
  );

/**
 * Floors, set below what the reader scores today so that ordinary noise does not fail the
 * build, and tightened whenever it improves. Raise them, never lower them, unless a label's
 * answer itself was wrong.
 */
const FLOORS = { countries: 0.97, cities: 0.93, recall: 0.99 };

describe("placing real location labels", () => {
  it("has answers for every label, and knows every region they name", () => {
    expect(rows.length).toBe(150);
    for (const row of rows) expect(() => expectedCountries(row.countries)).not.toThrow();
  });

  it(`names the right countries for at least ${FLOORS.countries * 100}% of labels`, () => {
    const right = scored.filter((result) => result.countriesRight).length;
    expect(share(right, scored.length), disagreements.join("\n")).toBeGreaterThanOrEqual(
      FLOORS.countries,
    );
  });

  it(`names the right cities for at least ${FLOORS.cities * 100}% of labels that name one`, () => {
    const judged = scored.filter((result) => result.citiesRight !== undefined);
    const right = judged.filter((result) => result.citiesRight === true).length;
    expect(share(right, judged.length), disagreements.join("\n")).toBeGreaterThanOrEqual(
      FLOORS.cities,
    );
  });

  it("finds every country a label names, even when it adds others", () => {
    const wanted = scored.reduce((total, result) => total + result.expected.size, 0);
    const found = scored.reduce(
      (total, result) =>
        total + [...result.expected].filter((code) => result.found.has(code)).length,
      0,
    );
    expect(share(found, wanted)).toBeGreaterThanOrEqual(FLOORS.recall);
  });

  /**
   * Labels whose reading was wrong once and must not go back. The whole set is asserted, not
   * merely that the right country is among them: the bug these pin produced the right country
   * buried in fourteen wrong ones.
   */
  it.each([
    // A misspelt city with the company's office list beside it: the office that repeats the
    // label places the posting, rather than every office the company has (#28).
    { label: "Karkiv", offices: ["Paris, France", "Lviv, Ukraine", "Karkiv, Ukraine"], is: "UA" },
    // Two-letter codes that are places, not time zones (#16).
    { label: "CT", offices: [], is: "US" },
    { label: "PT", offices: [], is: "PT" },
    // Four letters in capitals is a name, not a code (#16).
    { label: "OSLO", offices: [], is: "NO" },
    // A name two places share, settled by nothing else here.
    { label: "Georgia", offices: [], is: "GE" },
  ])("still reads $label as exactly $is", ({ label, offices, is }) => {
    const places = offices.map((text) => ({ label: null, text }));
    const located = locatePosting(
      { locations: [label], places, country: null, workplace: null },
      null,
    );
    expect(listed(new Set(located.places.map((place) => place.country)))).toBe(is);
  });
});
