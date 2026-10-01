import type { Workplace } from "@quarry/domain";
import type { EmploymentType } from "@quarry/facets";
import { EMPLOYMENT_CODES, type IndexQuery, WORKPLACE_CODES } from "@quarry/search-index";

/**
 * Everything a search is: what the person asked for, and which continent's postings are being
 * searched. There are no accounts, so this lives in the URL and nowhere else (K9), which makes
 * a search shareable and the back button work.
 */
export interface SearchState {
  readonly region: string;
  readonly text: string;
  readonly countries: readonly string[];
  readonly workplaces: readonly Workplace[];
  readonly employment: readonly EmploymentType[];
  readonly companies: readonly string[];
  /** Postings first seen or published within this many days. */
  readonly withinDays: number | null;
  readonly minimumPay: { readonly amount: number; readonly currency: string } | null;
  /** Postings open to anywhere match any place filter. */
  readonly includeAnywhere: boolean;
  readonly sort: "newest" | "pay";
  /** How many results are shown; growing it is what "show more" does. */
  readonly shown: number;
}

export const PAGE = 50;

export const EMPTY: SearchState = {
  region: "europe",
  text: "",
  countries: [],
  workplaces: [],
  employment: [],
  companies: [],
  withinDays: null,
  minimumPay: null,
  includeAnywhere: true,
  sort: "newest",
  shown: PAGE,
};

const WITHIN_DAYS = [1, 3, 7, 14, 30, 90];

/** Reads a search from a URL's query string, ignoring anything it doesn't recognize. */
export function fromUrl(url: URL, fallback: SearchState = EMPTY): SearchState {
  const parameters = url.searchParams;
  const list = (name: string) =>
    (parameters.get(name) ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
  const oneOf = <T extends string>(name: string, allowed: readonly T[]): T[] => {
    const values = list(name).filter((value): value is T =>
      (allowed as readonly string[]).includes(value),
    );
    return [...new Set(values)];
  };
  const days = Number(parameters.get("within"));
  const pay = Number(parameters.get("pay"));
  const currency = (parameters.get("currency") ?? "").toUpperCase();
  return {
    region: parameters.get("region") ?? fallback.region,
    text: parameters.get("q") ?? "",
    countries: [...new Set(list("country").map((code) => code.toUpperCase()))],
    workplaces: oneOf("workplace", WORKPLACE_CODES),
    employment: oneOf("type", EMPLOYMENT_CODES),
    companies: list("company"),
    withinDays: WITHIN_DAYS.includes(days) ? days : null,
    minimumPay:
      Number.isFinite(pay) && pay > 0 && /^[A-Z]{3}$/.test(currency)
        ? { amount: pay, currency }
        : null,
    includeAnywhere: parameters.get("anywhere") !== "0",
    sort: parameters.get("sort") === "pay" ? "pay" : "newest",
    shown: PAGE,
  };
}

/**
 * The query string for a search, with defaults left out so a plain search has a clean URL.
 * How many results are shown is deliberately not in it: it is where you are in the list, not
 * what you asked for, so sharing a link gives the other person the search, not your scrolling.
 */
export function toQueryString(state: SearchState): string {
  const parameters = new URLSearchParams();
  const set = (name: string, value: string) => {
    if (value.length > 0) parameters.set(name, value);
  };
  set("region", state.region === EMPTY.region ? "" : state.region);
  set("q", state.text.trim());
  set("country", state.countries.join(","));
  set("workplace", state.workplaces.join(","));
  set("type", state.employment.join(","));
  set("company", state.companies.join(","));
  set("within", state.withinDays === null ? "" : String(state.withinDays));
  if (state.minimumPay !== null) {
    set("pay", String(state.minimumPay.amount));
    set("currency", state.minimumPay.currency);
  }
  if (!state.includeAnywhere) set("anywhere", "0");
  set("sort", state.sort === "newest" ? "" : state.sort);
  const query = parameters.toString();
  return query.length === 0 ? "" : `?${query}`;
}

/** The query the index answers for a search. */
export function toQuery(state: SearchState, now: number): IndexQuery {
  return {
    ...(state.countries.length > 0 ? { places: { countries: state.countries } } : {}),
    includeAnywhere: state.includeAnywhere,
    ...(state.workplaces.length > 0 ? { workplaces: state.workplaces } : {}),
    ...(state.employment.length > 0 ? { employment: state.employment } : {}),
    ...(state.companies.length > 0 ? { companies: state.companies } : {}),
    ...(state.withinDays === null ? {} : { postedWithinDays: state.withinDays }),
    ...(state.minimumPay === null ? {} : { minimumPay: state.minimumPay }),
    ...(state.text.trim().length > 0 ? { text: state.text.trim() } : {}),
    sort: state.sort === "pay" ? { pay: state.minimumPay?.currency ?? "USD" } : "newest",
    limit: state.shown,
    now,
  };
}

/** Adds or removes one value of a multiple-choice filter, and starts the list again. */
export function toggle<T>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter((other) => other !== value) : [...values, value];
}

/** The filters in force, so they can be listed and removed one at a time. */
export function activeFilters(state: SearchState): { label: string; without: SearchState }[] {
  const filters: { label: string; without: SearchState }[] = [];
  const add = (label: string, without: Partial<SearchState>) =>
    filters.push({ label, without: { ...state, ...without, shown: PAGE } });
  if (state.text.trim().length > 0) add(`"${state.text.trim()}"`, { text: "" });
  for (const country of state.countries) {
    add(country, { countries: state.countries.filter((other) => other !== country) });
  }
  for (const workplace of state.workplaces) {
    add(workplace, { workplaces: state.workplaces.filter((other) => other !== workplace) });
  }
  for (const type of state.employment) {
    add(type, { employment: state.employment.filter((other) => other !== type) });
  }
  for (const company of state.companies) {
    add(company, { companies: state.companies.filter((other) => other !== company) });
  }
  if (state.withinDays !== null) add(`last ${state.withinDays} days`, { withinDays: null });
  if (state.minimumPay !== null) {
    add(`${state.minimumPay.currency} ${state.minimumPay.amount.toLocaleString("en-US")}+`, {
      minimumPay: null,
    });
  }
  if (!state.includeAnywhere) add("not open to anywhere", { includeAnywhere: true });
  return filters;
}
