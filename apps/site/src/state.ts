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
import { type CriterionDraft, draftOptions, MAX_POSTINGS } from "./criteria.ts";

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
  /**
   * The question this search is asking of its own results, if any.
   *
   * The wording is in the URL with the rest of the search, so a question can be shared, kept and
   * come back through the back button like every other filter. The answers are not: they are
   * large, and the server already keys them on the wording (ADR-0024), so whoever opens the link
   * and has the secret re-asks for nothing.
   */
  readonly criterion: CriterionDraft | null;
  /**
   * Narrowing by what the criterion answered: the answer must be one of these options, with at
   * least this probability. Held apart from `answers` because the index knows nothing about it,
   * so it is applied over the rows rather than inside the query.
   */
  readonly criterionFilter: {
    readonly options: readonly string[];
    readonly atLeast: number;
  } | null;
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
  criterion: null,
  criterionFilter: null,
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

/**
 * The criterion in a URL: its kind in `ck`, its wording in `cq`, and its options or levels in
 * `cc` separated by `|`. The wording is free text a person wrote, so it is carried as an ordinary
 * parameter value and escaped by `URLSearchParams` like any other.
 *
 * Anything malformed reads as no criterion rather than as a partial one. A half-read question
 * would be a different question, and the whole point of keying on the wording is that a different
 * wording is a different thing (ADR-0024).
 */
const CRITERION_KINDS: readonly CriterionDraft["kind"][] = ["yes-no", "choice", "scale"];

function readCriterionDraft(url: URL): CriterionDraft | null {
  const kind = url.searchParams.get("ck") ?? "";
  const question = (url.searchParams.get("cq") ?? "").trim();
  if (!CRITERION_KINDS.includes(kind as CriterionDraft["kind"])) return null;
  if (question === "") return null;
  const choices = (url.searchParams.get("cc") ?? "")
    .split("|")
    .map((choice) => choice.trim())
    .filter((choice) => choice.length > 0);
  if (kind !== "yes-no" && choices.length < 2) return null;
  return {
    kind: kind as CriterionDraft["kind"],
    question,
    choices: kind === "yes-no" ? [] : choices,
  };
}

/**
 * The criterion filter in a URL: `option|option@threshold` in `cf`, the same shape the standard
 * answer filters use. It is dropped unless the criterion it belongs to is there too, and unless
 * its options are that criterion's: a filter naming options of a question that is no longer in
 * the URL would hide everything for no visible reason.
 */
function readCriterionFilter(
  url: URL,
  criterion: CriterionDraft | null,
): SearchState["criterionFilter"] {
  if (criterion === null) return null;
  const found = /^([^@]+)(?:@(\d{1,3}))?$/.exec((url.searchParams.get("cf") ?? "").trim());
  if (found === null) return null;
  const [, joined = "", threshold] = found;
  const known = new Set(draftOptions(criterion).map((option) => option.id));
  const options = [...new Set(joined.split("|").filter((option) => known.has(option)))];
  if (options.length === 0) return null;
  const atLeast = threshold === undefined ? DEFAULT_ANSWER_THRESHOLD : Number(threshold);
  if (!(atLeast >= 1 && atLeast <= PROBABILITY_SCALE)) return null;
  return { options, atLeast };
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
  const criterion = readCriterionDraft(url);
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
    criterion,
    criterionFilter: readCriterionFilter(url, criterion),
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
  if (state.criterion !== null) {
    set("ck", state.criterion.kind);
    set("cq", state.criterion.question);
    set("cc", state.criterion.choices.join("|"));
    if (state.criterionFilter !== null) {
      const { options, atLeast } = state.criterionFilter;
      const threshold = atLeast === DEFAULT_ANSWER_THRESHOLD ? "" : `@${String(atLeast)}`;
      set("cf", `${options.join("|")}${threshold}`);
    }
  }
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

/**
 * Replaces the criterion, dropping any filter that was narrowing by its answers.
 *
 * Changing a word makes a different question whose old answers are answers to something else
 * (ADR-0024), so a filter written against the previous wording has to go rather than be carried
 * across and silently mean something new.
 */
export function setCriterion(state: SearchState, criterion: CriterionDraft | null): SearchState {
  return { ...state, criterion, criterionFilter: null, shown: PAGE };
}

/** Sets or clears the filter on the criterion's own answers. No options means no filter. */
export function setCriterionFilter(
  state: SearchState,
  options: readonly string[],
  atLeast: number,
): SearchState {
  if (state.criterion === null || options.length === 0) {
    return { ...state, criterionFilter: null, shown: PAGE };
  }
  return { ...state, criterionFilter: { options: [...options], atLeast }, shown: PAGE };
}

/** How a criterion and the options it is filtered to read in a chip. */
function describeCriterion(state: SearchState): string {
  const criterion = state.criterion;
  if (criterion === null) return "";
  const filter = state.criterionFilter;
  if (filter === null) return `asking: ${criterion.question}`;
  const labels = draftOptions(criterion)
    .filter((option) => filter.options.includes(option.id))
    .map((option) => option.label)
    .join(" or ");
  return `${criterion.question} ${labels} (${filter.atLeast}%+)`;
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
  // Removing the criterion's chip removes the whole question, not only the narrowing: a question
  // with nothing narrowing by it is still shown beside every result, so clearing it has to be
  // one action rather than two that look the same.
  if (state.criterion !== null) {
    add(describeCriterion(state), { criterion: null, criterionFilter: null });
  }
  return filters;
}

/**
 * Whether the postings a search leaves can be asked about: the server refuses more than
 * `MAX_POSTINGS` and says to filter further (ADR-0027), so the page does not offer it either.
 *
 * It is also what makes narrowing by a criterion answer exact. Below the cap, one query returns
 * every matching row, so filtering them by their answers is filtering the whole result and not
 * just the page being looked at.
 */
export function askable(total: number): boolean {
  return total > 0 && total <= MAX_POSTINGS;
}
