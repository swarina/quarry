import type { Workplace } from "@quarry/domain";
import type { EmploymentType } from "@quarry/facets";
import {
  DEFAULT_ANSWER_THRESHOLD,
  EMPLOYMENT_CODES,
  type IndexQuery,
  PROBABILITY_SCALE,
  type ShardQuestion,
  WORKPLACE_CODES,
} from "@quarry/search-index";

/**
 * A criterion on one standard question: the answer must be one of these options, with at least
 * this probability (in hundredths). Question and option ids are not checked here, because the
 * index is what knows them; it ignores any it does not carry, the same way an unknown country
 * code simply matches nothing.
 */
export interface AnswerFilter {
  readonly question: string;
  readonly options: readonly string[];
  readonly atLeast: number;
}

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
  /** Criteria on the standard questions, at most one per question. */
  readonly answers: readonly AnswerFilter[];
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
  answers: [],
  shown: PAGE,
};

const WITHIN_DAYS = [1, 3, 7, 14, 30, 90];

/**
 * An answer criterion in a URL: `question:option|option@threshold`, several separated by commas,
 * with the threshold left out when it is the default. Only characters that survive a query
 * string unescaped are used for the question and option ids, which the registry's ids are.
 */
const ANSWER_FILTER = /^([A-Za-z][A-Za-z0-9]*):([A-Za-z0-9_|]+?)(?:@(\d{1,3}))?$/;

function readAnswerFilters(value: string): AnswerFilter[] {
  const filters: AnswerFilter[] = [];
  const seen = new Set<string>();
  for (const entry of value.split(",")) {
    const found = ANSWER_FILTER.exec(entry.trim());
    if (found === null) continue;
    const [, question = "", joined = "", threshold] = found;
    // One criterion per question: a second one for the same question would be unanswerable.
    if (seen.has(question)) continue;
    const options = [...new Set(joined.split("|").filter((option) => option.length > 0))];
    if (options.length === 0) continue;
    const atLeast = threshold === undefined ? DEFAULT_ANSWER_THRESHOLD : Number(threshold);
    // A threshold of 0 would match any answer at all, which is what no filter already means.
    if (!(atLeast >= 1 && atLeast <= PROBABILITY_SCALE)) continue;
    seen.add(question);
    filters.push({ question, options, atLeast });
  }
  return filters;
}

function writeAnswerFilters(filters: readonly AnswerFilter[]): string {
  return filters
    .map((filter) => {
      const options = filter.options.join("|");
      const threshold =
        filter.atLeast === DEFAULT_ANSWER_THRESHOLD ? "" : `@${String(filter.atLeast)}`;
      return `${filter.question}:${options}${threshold}`;
    })
    .join(",");
}

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
    answers: readAnswerFilters(parameters.get("a") ?? ""),
    shown: PAGE,
  };
}

/**
 * The query string for a search, with defaults left out so a plain search has a clean URL.
 * The region is always in it, even when it is the one this browser would have chosen: without
 * it a shared link means "wherever you are", and a search for jobs in Germany opens almost
 * empty for someone whose browser starts in another continent.
 *
 * How many results are shown is deliberately not in it: it is where you are in the list, not
 * what you asked for, so sharing a link gives the other person the search, not your scrolling.
 */
export function toQueryString(state: SearchState): string {
  const parameters = new URLSearchParams();
  const set = (name: string, value: string) => {
    if (value.length > 0) parameters.set(name, value);
  };
  set("region", state.region);
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
  set("a", writeAnswerFilters(state.answers));
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
    ...(state.answers.length > 0 ? { answers: state.answers } : {}),
    sort: state.sort === "pay" ? { pay: state.minimumPay?.currency ?? "USD" } : "newest",
    limit: state.shown,
    now,
  };
}

/** Adds or removes one value of a multiple-choice filter, and starts the list again. */
export function toggle<T>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter((other) => other !== value) : [...values, value];
}

/** The criterion in force on one question, if any. */
export function answerFilter(state: SearchState, question: string): AnswerFilter | undefined {
  return state.answers.find((filter) => filter.question === question);
}

/**
 * Sets, changes, or clears the criterion on one question. Choosing no options clears it, since
 * a criterion matching no option would hide every posting.
 */
export function setAnswerFilter(
  state: SearchState,
  question: string,
  options: readonly string[],
  atLeast: number,
): SearchState {
  const others = state.answers.filter((filter) => filter.question !== question);
  const answers =
    options.length === 0 ? others : [...others, { question, options: [...options], atLeast }];
  return { ...state, answers, shown: PAGE };
}

/** How a question and its options read in a filter chip, given what the index calls them. */
function describeAnswer(filter: AnswerFilter, questions: readonly ShardQuestion[]): string {
  const question = questions.find((entry) => entry.id === filter.question);
  const name = (option: string) => {
    const at = question?.options.indexOf(option) ?? -1;
    return at < 0 ? option : (question?.labels[at] ?? option);
  };
  const shown = filter.options.map(name).join(" or ");
  const subject = question?.about ?? filter.question;
  return `${subject}: ${shown} (${filter.atLeast}%+)`;
}

/**
 * The filters in force, so they can be listed and removed one at a time. `questions` is what
 * the loaded index carries, used to name answer filters; without it they read as their ids.
 */
export function activeFilters(
  state: SearchState,
  questions: readonly ShardQuestion[] = [],
): { label: string; without: SearchState }[] {
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
  for (const filter of state.answers) {
    add(describeAnswer(filter, questions), {
      answers: state.answers.filter((other) => other.question !== filter.question),
    });
  }
  return filters;
}
