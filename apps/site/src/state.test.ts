import type { ResultRow } from "@quarry/search-index";
import { describe, expect, it } from "vitest";
import { regionOfZone } from "./catalog.ts";
import { where } from "./format.ts";
import { activeFilters, EMPTY, fromUrl, PAGE, toggle, toQuery, toQueryString } from "./state.ts";

const url = (query: string) => new URL(`https://quarry.example${query}`);
const read = (query: string) => fromUrl(url(query));

describe("a search in the URL", () => {
  it("reads every filter back", () => {
    const state = read(
      "?region=asia&q=platform&country=DE,JP&workplace=remote&type=full-time,contract" +
        "&company=Acme&within=7&pay=90000&currency=eur&anywhere=0&sort=pay",
    );
    expect(state).toEqual({
      region: "asia",
      text: "platform",
      countries: ["DE", "JP"],
      workplaces: ["remote"],
      employment: ["full-time", "contract"],
      companies: ["Acme"],
      withinDays: 7,
      minimumPay: { amount: 90_000, currency: "EUR" },
      includeAnywhere: false,
      sort: "pay",
      shown: PAGE,
    });
  });

  it("survives a round trip", () => {
    const query =
      "?region=asia&q=platform&country=DE%2CJP&workplace=remote&type=full-time&company=Acme" +
      "&within=7&pay=90000&currency=EUR&anywhere=0&sort=pay";
    expect(toQueryString(read(query))).toBe(query);
  });

  it("leaves defaults out, so a plain search has a clean URL", () => {
    expect(toQueryString(EMPTY)).toBe("?region=europe");
    expect(toQueryString({ ...EMPTY, text: "  data  " })).toBe("?region=europe&q=data");
  });

  it("always names the region, so a shared link means the same place for everyone", () => {
    const shared = toQueryString({ ...EMPTY, region: "europe", countries: ["DE"] });
    expect(shared).toContain("region=europe");
    // Whatever continent the other person's browser would have started in.
    expect(fromUrl(url(shared), { ...EMPTY, region: "north-america" }).region).toBe("europe");
  });

  it("keeps how far you have scrolled out of the URL", () => {
    expect(toQueryString({ ...EMPTY, shown: 500 })).toBe("?region=europe");
    expect(read("?q=a&shown=500").shown).toBe(PAGE);
  });

  it.each([
    ["?workplace=telepathic", "workplaces"],
    ["?type=freelance", "employment"],
    ["?within=9999", "withinDays"],
    ["?pay=-5&currency=EUR", "minimumPay"],
    ["?pay=90000&currency=euros", "minimumPay"],
    ["?sort=alphabetical", "sort"],
  ] as const)("ignores what it does not recognize: %s", (query, field) => {
    expect(read(query)[field]).toEqual(EMPTY[field]);
  });

  it("takes the region from the fallback when the URL names none", () => {
    expect(fromUrl(url("?q=a"), { ...EMPTY, region: "africa" }).region).toBe("africa");
  });
});

describe("the query a search becomes", () => {
  it("asks only for the filters in force", () => {
    expect(toQuery(EMPTY, 0)).toEqual({
      includeAnywhere: true,
      sort: "newest",
      limit: PAGE,
      now: 0,
    });
  });

  it("sorts by pay in the currency the filter names", () => {
    const state = { ...EMPTY, sort: "pay" as const, minimumPay: { amount: 1, currency: "GBP" } };
    expect(toQuery(state, 0).sort).toEqual({ pay: "GBP" });
    expect(toQuery({ ...EMPTY, sort: "pay" }, 0).sort).toEqual({ pay: "USD" });
  });

  it("passes places, text, and dates through", () => {
    const state = { ...EMPTY, countries: ["FR"], text: " remote ", withinDays: 3 };
    expect(toQuery(state, 5)).toMatchObject({
      places: { countries: ["FR"] },
      text: "remote",
      postedWithinDays: 3,
      now: 5,
    });
  });
});

describe("removing filters", () => {
  it("lists each one with the search that drops it", () => {
    const state = { ...EMPTY, countries: ["DE", "FR"], text: "data", withinDays: 30 };
    const filters = activeFilters(state);
    expect(filters.map((filter) => filter.label)).toEqual(['"data"', "DE", "FR", "last 30 days"]);
    expect(filters[1]?.without.countries).toEqual(["FR"]);
    expect(filters[0]?.without.text).toBe("");
  });

  it("starts the list again, so dropping a filter does not keep a deep page", () => {
    const filters = activeFilters({ ...EMPTY, text: "data", shown: 500 });
    expect(filters[0]?.without.shown).toBe(PAGE);
  });

  it("toggles one value of a multiple choice", () => {
    expect(toggle(["a", "b"], "b")).toEqual(["a"]);
    expect(toggle(["a"], "b")).toEqual(["a", "b"]);
  });
});

describe("the region a browser starts in", () => {
  it.each([
    ["Europe/Berlin", "europe"],
    ["America/New_York", "north-america"],
    ["America/Sao_Paulo", "south-america"],
    ["America/Argentina/Buenos_Aires", "south-america"],
    ["Asia/Tokyo", "asia"],
    ["Africa/Lagos", "africa"],
    ["Australia/Sydney", "oceania"],
    ["Pacific/Auckland", "oceania"],
    ["UTC", "europe"],
    ["", "europe"],
  ])("puts %s in %s", (zone, region) => {
    expect(regionOfZone(zone)).toBe(region);
  });
});

describe("where a posting is", () => {
  const row = (fields: Partial<ResultRow>): ResultRow =>
    ({ cities: [], countries: [], anywhere: false, ...fields }) as ResultRow;

  it.each([
    [row({ anywhere: true, countries: ["DE"] }), "Anywhere"],
    [row({ cities: ["Berlin"], countries: ["DE"] }), "Berlin"],
    [row({ cities: ["Berlin", "Berlin"] }), "Berlin"],
    [row({ cities: ["Berlin", "Munich", "Paris", "Rome"] }), "Berlin, Munich, Paris and 1 more"],
    [row({ countries: ["DE", "FR"] }), "Germany, France"],
    // A posting open across a whole region names more countries than anyone reads.
    [row({ countries: ["AD", "AL", "AT", "BE", "BG"] }), "5 countries"],
    // Cities are what people want, however many countries the posting also names.
    [row({ cities: ["Berlin"], countries: ["AD", "AL", "AT", "BE", "BG"] }), "Berlin"],
    [row({}), "Location not stated"],
  ])("reads as %j -> %s", (found, expected) => {
    expect(where(found, "en")).toBe(expected);
  });
});
