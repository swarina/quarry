import { DEFAULT_ANSWER_THRESHOLD, type ResultRow, type ShardQuestion } from "@quarry/search-index";
import { describe, expect, it } from "vitest";
import { regionOfZone } from "./catalog.ts";
import { confidenceBand, where } from "./format.ts";
import {
  activeFilters,
  answerFilter,
  EMPTY,
  fromUrl,
  PAGE,
  setAnswerFilter,
  toggle,
  toQuery,
  toQueryString,
} from "./state.ts";

const url = (query: string) => new URL(`https://quarry.example${query}`);
const read = (query: string) => fromUrl(url(query));

describe("a search in the URL", () => {
  it("reads every filter back", () => {
    const state = read(
      "?region=asia&q=platform&country=DE,JP&workplace=remote&type=full-time,contract" +
        "&company=Acme&within=7&pay=90000&currency=eur&anywhere=0&sort=pay" +
        "&a=arrangement:remote|hybrid@70,onCall:no",
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
      answers: [
        { question: "arrangement", options: ["remote", "hybrid"], atLeast: 70 },
        // No threshold in the URL means the default, more likely than not.
        { question: "onCall", options: ["no"], atLeast: DEFAULT_ANSWER_THRESHOLD },
      ],
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

describe("answer criteria in the URL", () => {
  it("survives a round trip, leaving a default threshold out", () => {
    const query = "?region=europe&a=arrangement%3Aremote%7Chybrid%4070%2ConCall%3Ano";
    const state = read(query);
    expect(state.answers).toEqual([
      { question: "arrangement", options: ["remote", "hybrid"], atLeast: 70 },
      { question: "onCall", options: ["no"], atLeast: DEFAULT_ANSWER_THRESHOLD },
    ]);
    expect(toQueryString(state)).toBe(query);
  });

  it.each([
    ["no options", "a=arrangement:"],
    ["no question", "a=:remote"],
    ["a threshold of zero, which is what no filter means", "a=arrangement:remote@0"],
    ["a threshold above certainty", "a=arrangement:remote@101"],
    ["a threshold that is not a number", "a=arrangement:remote@lots"],
    ["nothing at all", "a="],
  ])("ignores %s", (_name, query) => {
    expect(read(`?${query}`).answers).toEqual([]);
  });

  it("keeps only the first criterion for a question, since two cannot both hold", () => {
    expect(read("?a=arrangement:remote@60,arrangement:onsite@90").answers).toEqual([
      { question: "arrangement", options: ["remote"], atLeast: 60 },
    ]);
  });

  it("drops a repeated option rather than counting it twice", () => {
    expect(read("?a=arrangement:remote|remote").answers[0]?.options).toEqual(["remote"]);
  });

  it("passes the criteria to the index as they are", () => {
    const state = read("?a=arrangement:remote@80");
    expect(toQuery(state, 0).answers).toEqual([
      { question: "arrangement", options: ["remote"], atLeast: 80 },
    ]);
  });

  it("sends no criteria when there are none, rather than an empty list", () => {
    expect(toQuery(EMPTY, 0)).not.toHaveProperty("answers");
  });
});

describe("changing an answer criterion", () => {
  const base = { ...EMPTY, shown: 200 };

  it("sets one and starts the list again", () => {
    const next = setAnswerFilter(base, "arrangement", ["remote"], 70);
    expect(answerFilter(next, "arrangement")).toEqual({
      question: "arrangement",
      options: ["remote"],
      atLeast: 70,
    });
    expect(next.shown).toBe(PAGE);
  });

  it("replaces the criterion on a question instead of adding a second", () => {
    const once = setAnswerFilter(base, "arrangement", ["remote"], 70);
    const twice = setAnswerFilter(once, "arrangement", ["hybrid"], 90);
    expect(twice.answers).toHaveLength(1);
    expect(answerFilter(twice, "arrangement")?.options).toEqual(["hybrid"]);
  });

  it("clears the criterion when no option is left, rather than matching nothing", () => {
    const once = setAnswerFilter(base, "arrangement", ["remote"], 70);
    expect(setAnswerFilter(once, "arrangement", [], 70).answers).toEqual([]);
  });

  it("leaves other questions alone", () => {
    const once = setAnswerFilter(base, "arrangement", ["remote"], 70);
    const both = setAnswerFilter(once, "onCall", ["no"], 60);
    expect(both.answers.map((filter) => filter.question)).toEqual(["arrangement", "onCall"]);
  });
});

describe("an answer criterion as a chip", () => {
  const QUESTIONS: ShardQuestion[] = [
    {
      id: "arrangement",
      version: 1,
      about: "Where the work is done",
      kind: "choice",
      options: ["remote", "hybrid"],
      labels: ["Fully remote", "Some office days"],
    },
  ];

  it("reads with the index's own words, and drops only itself", () => {
    const state = setAnswerFilter(EMPTY, "arrangement", ["remote", "hybrid"], 70);
    const [chip] = activeFilters(state, QUESTIONS);
    expect(chip?.label).toBe("Where the work is done: Fully remote or Some office days (70%+)");
    expect(chip?.without.answers).toEqual([]);
  });

  it("falls back to the ids when the index does not carry the question", () => {
    const state = setAnswerFilter(EMPTY, "mystery", ["yes"], 50);
    expect(activeFilters(state, QUESTIONS)[0]?.label).toBe("mystery: yes (50%+)");
  });
});

describe("confidence bands", () => {
  it.each([
    [100, "likely"],
    [70, "likely"],
    [69, "maybe"],
    [40, "maybe"],
    [39, "unlikely"],
    [0, "unlikely"],
  ])("reads %i%% as %s", (probability, expected) => {
    expect(confidenceBand(probability).id).toBe(expected);
  });
});
