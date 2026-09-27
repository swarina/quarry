import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { gazetteer } from "./gazetteer.ts";
import { type LabelReading, type ReadingHints, readLabel } from "./read-label.ts";

const { cities, countries, divisions } = gazetteer();
const cityNames = new Map(cities.map((city) => [city.id, city.name]));

/** A reading in short form: "country/division/city" per place, then the flags. */
function short(label: string, hints?: ReadingHints): string {
  return render(readLabel(label, hints));
}

function render(reading: LabelReading): string {
  const places = reading.places.map((place) =>
    [place.country, place.division, place.city === null ? null : cityNames.get(place.city)]
      .filter((part) => part !== null)
      .join("/"),
  );
  return [
    ...places,
    ...(reading.workplace === null ? [] : [reading.workplace]),
    ...(reading.anywhere ? ["anywhere"] : []),
  ].join(" + ");
}

describe("readLabel", () => {
  it.each([
    ["San Francisco, CA", "US/CA/San Francisco"],
    ["New York, NY, United States", "US/NY/New York City"],
    ["Berlin, Berlin, Germany", "DE/16/Berlin"],
    ["London", "GB/ENG/London"],
    ["Paris", "FR/11/Paris"],
    ["Paris, TX", "US/TX/Paris"],
    ["Bengaluru, Karnataka, India", "IN/19/Bengaluru"],
    ["Bangalore", "IN/19/Bengaluru"],
    ["Cologne, Germany", "DE/07/Köln"],
    ["Taiwan, Taipei", "TW/04/Taipei"],
    ["UK - London", "GB/ENG/London"],
    ["Toronto, ON", "CA/08/Toronto"],
    ["Sydney NSW", "AU/02/Sydney"],
    ["Austin TX", "US/TX/Austin"],
    ["Washington, D.C.", "US/DC/Washington"],
    ["Erie, PA", "US/PA/Erie"],
    ["Hsinchu City", "TW/04/Hsinchu"],
  ])("places a city: %s", (label, expected) => {
    expect(short(label)).toBe(expected);
  });

  it.each([
    ["Spain", "ES"],
    ["USA", "US"],
    ["U.K.", "GB"],
    ["Deutschland", "DE"],
    ["Brasil", "BR"],
    ["Republic of Ireland", "IE"],
    ["Bayern", "DE/02"],
    ["Masovian Voivodeship", "PL/78"],
    ["British Columbia", "CA/02"],
    ["England", "GB/ENG"],
  ])("places a country or division: %s", (label, expected) => {
    expect(short(label)).toBe(expected);
  });

  it.each([
    ["Remote - US", "US + remote"],
    ["United States - Remote", "US + remote"],
    ["Remote (UK)", "GB + remote"],
    ["CAN: British Columbia Remote", "CA/02 + remote"],
    ["Remote-Ohio", "US/OH + remote"],
    ["Remote in Canada", "CA + remote"],
    ["Remoto", "remote"],
    ["Hybrid", "hybrid"],
    ["Berlin, Germany (Hybrid)", "DE/16/Berlin + hybrid"],
    ["Office Based - Taipei, Taiwan", "TW/04/Taipei + onsite"],
    ["Home based - Worldwide", "remote + anywhere"],
    ["Remote, Global", "remote + anywhere"],
  ])("reads the arrangement: %s", (label, expected) => {
    expect(short(label)).toBe(expected);
  });

  it.each([
    ["San Francisco, CA | New York City, NY", "US/CA/San Francisco + US/NY/New York City"],
    ["Berlin; Frankfurt; Munich", "DE/16/Berlin + DE/05/Frankfurt am Main + DE/02/Munich"],
    ["Dublin or Berlin", "IE/L/Dublin + DE/16/Berlin"],
    ["London & Amsterdam", "GB/ENG/London + NL/07/Amsterdam"],
    ["San Francisco, CA • New York, NY", "US/CA/San Francisco + US/NY/New York City"],
    [
      "US: SF, NYC, Seattle and Remote",
      "US/CA/San Francisco + US/NY/New York City + US/WA/Seattle + remote",
    ],
    [
      "SEA, SF, NYC, CHI",
      "US/WA/Seattle + US/CA/San Francisco + US/NY/New York City + US/IL/Chicago",
    ],
    ["Kitchener-Waterloo, ON; Toronto, ON", "CA/08/Kitchener + CA/08/Waterloo + CA/08/Toronto"],
    ["London / Austria / Switzerland / Netherlands", "GB/ENG/London + AT + CH + NL"],
  ])("lists several places: %s", (label, expected) => {
    expect(short(label)).toBe(expected);
  });

  it("expands regions to their countries", () => {
    expect(short("Remote-Nordics")).toBe("DK + FI + IS + NO + SE + remote");
    expect(short("DACH")).toBe("AT + CH + DE");
    expect(readLabel("EMEA").places.map((place) => place.country)).toEqual(
      expect.arrayContaining(["DE", "NG", "AE", "GB"]),
    );
    expect(readLabel("EU").places).toHaveLength(27);
  });

  it("settles ambiguous names with the rest of the label", () => {
    expect(short("Georgia/Florida, US")).toBe("US/GA + US/FL");
    expect(short("Georgia")).toBe("GE");
    expect(short("CA • San Francisco")).toBe("US/CA/San Francisco");
    expect(short("Canada - Remote (ON, AB, BC, or NS Only)")).toBe(
      "CA/08 + CA/01 + CA/02 + CA/07 + remote",
    );
    expect(short("New York")).toBe("US/NY/New York City");
    expect(short("Washington")).toBe("US/WA");
    expect(short("Wellington")).toBe("NZ/G2/Wellington");
  });

  it("settles ambiguous names with hints when the label can't", () => {
    expect(short("IN")).toBe("IN");
    expect(short("IN", { countries: ["US"] })).toBe("US/IN");
    expect(short("Georgia", { countries: ["US"] })).toBe("US/GA");
    expect(short("London", { countries: ["CA"] })).toBe("CA/08/London");
    expect(short("Cambridge", { home: "US" })).toBe("US/MA/Cambridge");
  });

  it("leaves out what only looks like a place", () => {
    // A small foreign place next to a named country, and a code that is a division here.
    expect(short("Remote in the United States or Canada (West Coast/PT)")).toBe("US + CA + remote");
    expect(short("Bergamo, BG, Italy")).toBe("IT/09/Bergamo");
    expect(short("BZ - Sao Paulo")).toBe("BR/27/São Paulo");
    // Street addresses, floors, company names, and "n/a".
    expect(short("AU: Melbourne: (260 Burwood Rd)")).toBe("AU/07/Melbourne");
    expect(short("NZ: Auckland: Xero 4 (96 St Georges Bay Rd, Level 2 & 3)")).toBe(
      "NZ/E7/Auckland",
    );
    expect(short("Strava SF")).toBe("US/CA/San Francisco");
    expect(short("N/A")).toBe("");
    expect(readLabel("Jobs.cz").unmatched).toEqual(["Jobs.cz"]);
  });

  it("reads flag emoji as countries", () => {
    const flag = (code: string) =>
      String.fromCodePoint(...Array.from(code, (letter) => 0x1f1e6 + letter.charCodeAt(0) - 65));
    expect(short(`Lyon ${flag("FR")}`)).toBe("FR/84/Lyon");
    expect(short(`${flag("DE")} Remote`)).toBe("DE + remote");
  });

  test.prop([fc.string({ maxLength: 80 })])("reads any text into known places", (label) => {
    const reading = readLabel(label);
    const countryCodes = new Set(countries.map((country) => country.code));
    const divisionIds = new Set(
      divisions.map((division) => `${division.country}.${division.code}`),
    );
    for (const place of reading.places) {
      expect(countryCodes).toContain(place.country);
      if (place.division !== null)
        expect(divisionIds).toContain(`${place.country}.${place.division}`);
      if (place.city !== null) expect(cityNames.has(place.city)).toBe(true);
    }
    expect(readLabel(label)).toEqual(reading);
  });
});
