import { describe, expect, it } from "vitest";
import { gazetteer } from "./gazetteer.ts";

const { countries, divisions, cities, source, retrieved } = gazetteer();

describe("gazetteer", () => {
  it("credits GeoNames, as its license requires", () => {
    expect(source).toBe("GeoNames (https://www.geonames.org), licensed under CC BY 4.0");
    expect(retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("has every current country once, with its codes and continent", () => {
    expect(countries.length).toBeGreaterThan(240);
    expect(new Set(countries.map((country) => country.code)).size).toBe(countries.length);
    for (const country of countries) {
      expect(country.code).toMatch(/^[A-Z]{2}$/);
      expect(country.iso3).toMatch(/^[A-Z]{3}$/);
      expect(["AF", "AN", "AS", "EU", "NA", "OC", "SA"]).toContain(country.continent);
    }
    // Withdrawn from ISO 3166-1, though GeoNames still lists them.
    expect(countries.map((country) => country.code)).not.toContain("AN");
    expect(countries.find((country) => country.code === "DE")).toMatchObject({
      iso3: "DEU",
      name: "Germany",
      continent: "EU",
    });
  });

  it("links every division and city to places that exist", () => {
    const countryCodes = new Set(countries.map((country) => country.code));
    const divisionIds = new Set(
      divisions.map((division) => `${division.country}.${division.code}`),
    );
    expect(divisionIds.size).toBe(divisions.length);
    expect(new Set(cities.map((city) => city.id)).size).toBe(cities.length);
    // Collected rather than asserted one by one: an assertion per city is tens of thousands of
    // them, which took longer than the test timeout, and a list of what is wrong reads better
    // than the first failure.
    const dangling: string[] = [];
    for (const division of divisions) {
      if (!countryCodes.has(division.country)) {
        dangling.push(`division ${division.country}.${division.code} has no country`);
      }
    }
    for (const city of cities) {
      if (!countryCodes.has(city.country)) dangling.push(`city ${city.id} has no country`);
      if (city.division !== "" && !divisionIds.has(`${city.country}.${city.division}`)) {
        dangling.push(`city ${city.id} names division ${city.country}.${city.division}`);
      }
    }
    expect(dangling).toEqual([]);
  });

  it("keeps the alternate names labels use, and none that belong elsewhere", () => {
    // The most populous city of that name: there are several San Franciscos.
    const byName = (name: string) =>
      cities
        .filter((city) => city.name === name)
        .sort((left, right) => right.population - left.population)[0];
    expect(byName("San Francisco")).toMatchObject({ country: "US", division: "CA" });
    expect(byName("New York City")?.alternates).toContain("New York");
    // Alternates are distinct once accents and case are folded away, which is how they match.
    const fold = (name: string) => name.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    expect(byName("Munich")?.alternates.map(fold)).toContain("munchen");
    for (const city of cities) {
      expect(new Set(city.alternates.map(fold)).size).toBe(city.alternates.length);
    }
    expect(byName("Bengaluru")?.alternates).toContain("Bangalore");
    expect(byName("Kuwait City")?.alternates).toContain("Kuwait");
    const everyAlternate = new Set(cities.flatMap((city) => city.alternates));
    for (const wrong of ["USA", "India", "Ireland", "Germany", "MUC", "NYC"]) {
      expect(everyAlternate).not.toContain(wrong);
    }
    for (const name of everyAlternate) expect(name).toMatch(/^\p{Lu}/u);
  });
});
