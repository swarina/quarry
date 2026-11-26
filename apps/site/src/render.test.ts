/**
 * What the page says about its own pay ranking.
 *
 * Pay is kept in the currency the posting stated and the index carries no exchange rates
 * (ADR-0007), so "highest pay first" ranks within one currency and leaves everything else in
 * date order. These tests are over the sentence that says so, because the ranking being partial
 * is only a defect when the page hides it: the numbers here are the shape of a real search of
 * Europe over the built index, where 357 of the 702 postings that state pay state it in euros.
 */
import type { QueryResult } from "@quarry/search-index";
import { describe, expect, it } from "vitest";
import { payCurrencyChoices, payNote, type View } from "./render.ts";
import { EMPTY, type SearchState } from "./state.ts";

const EUROPE: readonly (readonly [string, number])[] = [
  ["EUR", 357],
  ["GBP", 197],
  ["USD", 55],
  ["PLN", 52],
  ["CAD", 26],
  ["SEK", 8],
  ["DKK", 4],
  ["CHF", 1],
  ["SGD", 1],
  ["ALL", 1],
];

function view(pay: QueryResult["pay"], total: number, state: Partial<SearchState> = {}): View {
  const result: QueryResult = {
    total,
    answered: 0,
    pay,
    rows: [],
    facets: { countries: [], workplaces: [], employment: [], companies: [], answers: [] },
  };
  return {
    state: { ...EMPTY, sort: "pay", ...state },
    result,
    links: new Map(),
    questions: [],
    answered: new Map(),
    held: undefined,
    now: 0,
    locale: undefined,
  };
}

describe("what the page says about a pay ranking", () => {
  it("names the currency and counts what it leaves in date order", () => {
    const note = payNote(view({ currencies: EUROPE, within: "EUR" }, 9761));
    expect(note).toBe(
      "Ranked by pay in EUR: 357 of these 9,761 postings. " +
        "The rest keep date order: 345 state pay in another currency, 9,059 state no pay.",
    );
  });

  it("says nothing when the order is by date", () => {
    expect(payNote(view({ currencies: EUROPE, within: null }, 9761, { sort: "newest" }))).toBe("");
  });

  it("leaves out a part there is nothing to say about", () => {
    expect(payNote(view({ currencies: [["EUR", 4]], within: "EUR" }, 4))).toBe(
      "Ranked by pay in EUR: 4 of these 4 postings.",
    );
    expect(payNote(view({ currencies: [["EUR", 4]], within: "EUR" }, 10))).toBe(
      "Ranked by pay in EUR: 4 of these 10 postings. The rest keep date order: 6 state no pay.",
    );
  });

  it("admits a ranking that ranked nothing rather than showing date order as one", () => {
    expect(payNote(view({ currencies: [], within: null }, 40))).toBe(
      "No posting here states pay, so these are in date order.",
    );
    const pinned = { currencies: EUROPE, within: "JPY" };
    expect(payNote(view(pinned, 9761, { payCurrency: "JPY" }))).toBe(
      "No posting here states pay in JPY, so these are in date order.",
    );
  });

  it("offers every currency the result states pay in, commonest first", () => {
    const choices = payCurrencyChoices(view({ currencies: EUROPE, within: "EUR" }, 9761));
    expect(choices.slice(0, 3)).toEqual([
      { value: "", label: "Most common (EUR)" },
      { value: "EUR", label: "EUR (357)" },
      { value: "GBP", label: "GBP (197)" },
    ]);
  });

  it("keeps a pinned currency the search has left behind", () => {
    // Dropping it would leave the control showing another currency while the URL, and the order
    // on screen, still meant this one.
    const choices = payCurrencyChoices(
      view({ currencies: [["EUR", 4]], within: "JPY" }, 4, { payCurrency: "JPY" }),
    );
    expect(choices).toEqual([
      { value: "", label: "Most common (EUR)" },
      { value: "EUR", label: "EUR (4)" },
      { value: "JPY", label: "JPY (0)" },
    ]);
  });
});
