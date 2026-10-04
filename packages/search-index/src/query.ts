import type { Workplace } from "@quarry/domain";
import type { EmploymentType } from "@quarry/facets";
import { DEFAULT_ANSWER_THRESHOLD, EMPLOYMENT_CODES, WORKPLACE_CODES } from "./format.ts";
import {
  employmentOf,
  type IndexTable,
  type ListColumn,
  searchFold,
  workplaceOf,
} from "./table.ts";

/** One criterion on one standard question. */
export interface AnswerCriterion {
  /** The question id, as the shard's `questions` names it. */
  readonly question: string;
  /** The option ids that count as a match; unknown options are ignored. */
  readonly options: readonly string[];
  /** The least probability, in hundredths, that the answer is one of them. */
  readonly atLeast?: number;
}

/** A posting's answer to one question, as a result carries it. */
export interface RowAnswer {
  readonly question: string;
  /** The likeliest option's id, which is the answer the model would have picked. */
  readonly option: string;
  /** How likely that option is, in hundredths. */
  readonly probability: number;
  /** Every option's probability, in the question's option order, for showing the spread. */
  readonly distribution: readonly number[];
}

export interface IndexQuery {
  /** Postings in any of these places. */
  readonly places?: {
    readonly countries?: readonly string[];
    /** "US.CA" */
    readonly divisions?: readonly string[];
    /** GeoNames ids. */
    readonly cities?: readonly number[];
  };
  /** Postings that can be done from anywhere match any place (default true). */
  readonly includeAnywhere?: boolean;
  readonly workplaces?: readonly Workplace[];
  readonly employment?: readonly EmploymentType[];
  readonly companies?: readonly string[];
  readonly postedWithinDays?: number;
  /** Pay stated in this currency, reaching at least this much a year. */
  readonly minimumPay?: { readonly amount: number; readonly currency: string };
  /** Words that must all appear in the title or company. */
  readonly text?: string;
  /**
   * Criteria on the standard questions. A posting matches when the probability that its answer
   * is one of `options` is at least `atLeast`, in hundredths (default 50, more likely than not).
   *
   * Asking about a set of options, rather than the one the model picked, is what makes a
   * threshold mean something: "remote or hybrid, at least 70% likely" keeps a posting the model
   * called hybrid at 40% with remote at 35%, which filtering on the picked option would drop.
   * A posting with no answer to the question never matches.
   */
  readonly answers?: readonly AnswerCriterion[];
  /** Newest first (the default), or highest pay in a currency first. */
  readonly sort?: "newest" | { readonly pay: string };
  readonly offset?: number;
  readonly limit?: number;
  /** For postedWithinDays, in epoch milliseconds; defaults to now. */
  readonly now?: number;
}

export interface ResultRow {
  readonly id: string;
  readonly title: string;
  readonly company: string;
  readonly locations: readonly string[];
  readonly countries: readonly string[];
  readonly cities: readonly string[];
  readonly workplace: Workplace | null;
  readonly anywhere: boolean;
  /** The only place is the company's home country, inferred rather than stated. */
  readonly inferred: boolean;
  readonly employmentTypes: readonly EmploymentType[];
  readonly department: string | null;
  readonly pay: {
    readonly min: number | null;
    readonly max: number | null;
    readonly currency: string;
  } | null;
  /** Days since 1970-01-01 (UTC), or null. */
  readonly postedDay: number | null;
  /** The answers held for this posting, for the questions it has been asked. */
  readonly answers: readonly RowAnswer[];
}

export interface QueryResult {
  readonly total: number;
  readonly rows: readonly ResultRow[];
  /**
   * For each facet, how many postings match every filter but that facet's own, per value,
   * largest first: what choosing another value would show.
   */
  readonly facets: {
    readonly countries: readonly (readonly [string, number])[];
    readonly workplaces: readonly (readonly [Workplace, number])[];
    readonly employment: readonly (readonly [EmploymentType, number])[];
    readonly companies: readonly (readonly [string, number])[];
    /**
     * Per question, what each option would give at that question's own threshold, and how many
     * of the matching postings hold an answer to it at all. The answered count is what keeps the
     * option counts honest while the corpus is only partly enriched: options that add up to far
     * fewer than the result total mean most postings have not been asked yet, not that the
     * answer is rare.
     */
    readonly answers: readonly {
      readonly question: string;
      readonly options: readonly (readonly [string, number])[];
      readonly answered: number;
    }[];
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 50;
const PLACE = 0;
const WORKPLACE = 1;
const EMPLOYMENT = 2;
const COMPANY = 3;
/** Each question is its own facet group, so its counts are of the other filters only. */
const ANSWER = 4;

/** A question's filter, resolved against the table's own question list. */
interface ResolvedCriterion {
  /** Index into `table.questions`, and so into `table.answers`. */
  readonly at: number;
  readonly width: number;
  /** Option indices that count as a match. */
  readonly options: readonly number[];
  readonly atLeast: number;
}

/** The probability, in hundredths, that row `row`'s answer to question `at` is one of `options`. */
function answerProbability(
  table: IndexTable,
  row: number,
  at: number,
  width: number,
  options: Iterable<number>,
): number {
  const column = table.answers[at];
  if (column === undefined) return 0;
  let total = 0;
  for (const option of options) total += column[row * width + option] ?? 0;
  return total;
}

function hasAnswer(table: IndexTable, row: number, at: number): boolean {
  return (((table.answered[row] ?? 0) >> at) & 1) === 1;
}

/** Filters, counts, and sorts the table in one pass over its rows. */
export function queryIndex(table: IndexTable, query: IndexQuery): QueryResult {
  const { dictionaries } = table;
  const setOf = <T>(values: readonly T[], lookup: readonly T[]) =>
    new Set(values.map((value) => lookup.indexOf(value)));
  const codes = <T>(values: readonly T[] | undefined, lookup: readonly T[]) =>
    values === undefined ? undefined : setOf(values, lookup);
  const places = query.places;
  const placeFilter =
    places === undefined
      ? undefined
      : {
          countries: setOf(places.countries ?? [], dictionaries.country),
          divisions: setOf(
            places.divisions ?? [],
            dictionaries.division.map(([id]) => id),
          ),
          cities: setOf(
            places.cities ?? [],
            dictionaries.city.map(([id]) => id),
          ),
        };
  const includeAnywhere = query.includeAnywhere ?? true;
  const workplaces = codes(query.workplaces, WORKPLACE_CODES);
  const employment = query.employment?.reduce(
    (bits, type) => bits | (1 << EMPLOYMENT_CODES.indexOf(type)),
    0,
  );
  const companies = codes(query.companies, dictionaries.company);
  const since =
    query.postedWithinDays === undefined
      ? undefined
      : Math.floor((query.now ?? Date.now()) / DAY_MS) - query.postedWithinDays;
  const pay =
    query.minimumPay === undefined
      ? undefined
      : { ...query.minimumPay, code: dictionaries.currency.indexOf(query.minimumPay.currency) };
  const terms = searchFold(query.text ?? "")
    .split(/\s+/)
    .filter((term) => term.length > 0);
  // Thresholds are per question, so a facet count can use the same one the filter used.
  const thresholds = table.questions.map(() => DEFAULT_ANSWER_THRESHOLD);
  const answerWidths = table.questions.map((question) => question.options.length);
  const criteria: ResolvedCriterion[] = [];
  for (const criterion of query.answers ?? []) {
    const at = table.questions.findIndex((question) => question.id === criterion.question);
    const question = table.questions[at];
    if (question === undefined) continue;
    const options = criterion.options
      .map((option) => question.options.indexOf(option))
      .filter((option) => option >= 0);
    if (options.length === 0) continue;
    const atLeast = criterion.atLeast ?? DEFAULT_ANSWER_THRESHOLD;
    thresholds[at] = atLeast;
    criteria.push({ at, width: question.options.length, options, atLeast });
  }

  const counts = {
    countries: new Map<number, number>(),
    workplaces: new Map<number, number>(),
    employment: new Map<number, number>(),
    companies: new Map<number, number>(),
    // Per question: a count per option, plus how many rows held an answer at all.
    answers: table.questions.map(() => ({
      options: new Map<number, number>(),
      answered: 0,
    })),
  };
  // A posting open to anywhere matches every country, so it belongs in every country's count.
  // Counting those rows apart keeps one that also names a country from being counted twice.
  let anywhereCounted = 0;
  const anywhereByCountry = new Map<number, number>();
  const matched: number[] = [];
  for (let row = 0; row < table.size; row += 1) {
    if (since !== undefined && (table.posted[row] ?? -1) < since) continue;
    if (pay !== undefined) {
      if (table.currency[row] !== pay.code || !(payReach(table, row) >= pay.amount)) continue;
    }
    if (terms.length > 0) {
      const text = table.searchText[row] ?? "";
      if (!terms.every((term) => text.includes(term))) continue;
    }

    let failed = -1;
    let failures = 0;
    const fail = (group: number) => {
      failed = group;
      failures += 1;
    };
    if (placeFilter !== undefined) {
      const inPlace =
        (includeAnywhere && table.anywhere[row] === 1) ||
        some(table.country, row, placeFilter.countries) ||
        some(table.division, row, placeFilter.divisions) ||
        some(table.city, row, placeFilter.cities);
      if (!inPlace) fail(PLACE);
    }
    if (workplaces !== undefined && !workplaces.has(table.workplace[row] ?? -1)) fail(WORKPLACE);
    if (employment !== undefined && ((table.employment[row] ?? 0) & employment) === 0)
      fail(EMPLOYMENT);
    if (companies !== undefined && !companies.has(table.company[row] ?? -1)) fail(COMPANY);
    for (const criterion of criteria) {
      const { at, width, options, atLeast } = criterion;
      // No answer is never a match: the question has not been asked about this posting.
      const matches =
        hasAnswer(table, row, at) && answerProbability(table, row, at, width, options) >= atLeast;
      if (!matches) fail(ANSWER + at);
    }
    if (failures > 1) continue;

    if (failures === 0) matched.push(row);
    if (failures === 0 || failed === PLACE) {
      forEachValue(table.country, row, (code) => increment(counts.countries, code));
      if (includeAnywhere && table.anywhere[row] === 1) {
        anywhereCounted += 1;
        forEachValue(table.country, row, (code) => increment(anywhereByCountry, code));
      }
    }
    if (failures === 0 || failed === WORKPLACE)
      increment(counts.workplaces, table.workplace[row] ?? -1);
    if (failures === 0 || failed === EMPLOYMENT) {
      const bits = table.employment[row] ?? 0;
      EMPLOYMENT_CODES.forEach((_, bit) => {
        if ((bits & (1 << bit)) !== 0) increment(counts.employment, bit);
      });
    }
    if (failures === 0 || failed === COMPANY) increment(counts.companies, table.company[row] ?? -1);
    for (let at = 0; at < answerWidths.length; at += 1) {
      if (failures !== 0 && failed !== ANSWER + at) continue;
      const tally = counts.answers[at];
      if (tally === undefined || !hasAnswer(table, row, at)) continue;
      tally.answered += 1;
      // What picking each option on its own would give, at the threshold in force. The column
      // is read directly: going through answerProbability here allocated an array per option
      // per row, which doubled the cost of a query with no answer filter at all.
      const width = answerWidths[at] ?? 0;
      const column = table.answers[at];
      if (column === undefined) continue;
      const atLeast = thresholds[at] ?? DEFAULT_ANSWER_THRESHOLD;
      const start = row * width;
      for (let option = 0; option < width; option += 1) {
        if ((column[start + option] ?? 0) >= atLeast) increment(tally.options, option);
      }
    }
  }

  const sort = query.sort ?? "newest";
  if (sort !== "newest") {
    const code = dictionaries.currency.indexOf(sort.pay);
    const amount = (row: number) =>
      table.currency[row] === code ? payReach(table, row) : Number.NaN;
    // Rows with pay in the currency first, highest first; the rest stay newest first.
    matched.sort((left, right) => {
      const [a, b] = [amount(left), amount(right)];
      if (Number.isNaN(a) || Number.isNaN(b))
        return (Number.isNaN(a) ? 1 : 0) - (Number.isNaN(b) ? 1 : 0) || left - right;
      return b - a || left - right;
    });
  }

  const offset = query.offset ?? 0;
  const limit = query.limit ?? DEFAULT_LIMIT;
  /**
   * Every country's count plus the postings open to anywhere, which choosing that country
   * would also show, less the ones already counted because they name it too.
   */
  const withAnywhere = (map: Map<number, number>) => {
    if (anywhereCounted === 0) return map;
    const all = new Map(map);
    for (const code of new Set([...map.keys(), ...anywhereByCountry.keys()])) {
      all.set(code, (map.get(code) ?? 0) + anywhereCounted - (anywhereByCountry.get(code) ?? 0));
    }
    return all;
  };
  const ranked = <T>(map: Map<number, number>, name: (code: number) => T | undefined) =>
    [...map]
      .flatMap(([code, count]) => {
        const value = name(code);
        return value === undefined ? [] : [[value, count] as const];
      })
      .sort((left, right) => right[1] - left[1] || String(left[0]).localeCompare(String(right[0])));
  return {
    total: matched.length,
    rows: matched.slice(offset, offset + limit).map((row) => resultRow(table, row)),
    facets: {
      countries: ranked(withAnywhere(counts.countries), (code) => dictionaries.country[code]),
      workplaces: ranked(counts.workplaces, (code) => workplaceOf(code) ?? undefined),
      employment: ranked(counts.employment, (bit) => EMPLOYMENT_CODES[bit]),
      companies: ranked(counts.companies, (code) => dictionaries.company[code]),
      answers: table.questions.map((question, at) => ({
        question: question.id,
        options: ranked(
          counts.answers[at]?.options ?? new Map(),
          (option) => question.options[option],
        ),
        answered: counts.answers[at]?.answered ?? 0,
      })),
    },
  };
}

function resultRow(table: IndexTable, row: number): ResultRow {
  const { dictionaries } = table;
  const values = (column: ListColumn) =>
    Array.from(column.values.subarray(column.offsets[row] ?? 0, column.offsets[row + 1] ?? 0));
  const currency = table.currency[row] ?? -1;
  const [min, max] = [table.payMin[row] ?? Number.NaN, table.payMax[row] ?? Number.NaN];
  const posted = table.posted[row] ?? -1;
  const department = table.department[row] ?? -1;
  return {
    id: table.id[row] ?? "",
    title: table.title[row] ?? "",
    company: dictionaries.company[table.company[row] ?? -1] ?? "",
    locations: values(table.location).map((code) => dictionaries.location[code] ?? ""),
    countries: values(table.country).map((code) => dictionaries.country[code] ?? ""),
    cities: values(table.city).map((code) => dictionaries.city[code]?.[1] ?? ""),
    workplace: workplaceOf(table.workplace[row] ?? -1),
    anywhere: table.anywhere[row] === 1,
    inferred: table.inferred[row] === 1,
    employmentTypes: employmentOf(table.employment[row] ?? 0),
    department: department < 0 ? null : (dictionaries.department[department] ?? null),
    pay:
      currency < 0
        ? null
        : {
            min: Number.isNaN(min) ? null : min,
            max: Number.isNaN(max) ? null : max,
            currency: dictionaries.currency[currency] ?? "",
          },
    postedDay: posted < 0 ? null : posted,
    answers: rowAnswers(table, row),
  };
}

/** A row's answers, leaving out the questions it has not been asked. */
function rowAnswers(table: IndexTable, row: number): RowAnswer[] {
  const answers: RowAnswer[] = [];
  table.questions.forEach((question, at) => {
    if (!hasAnswer(table, row, at)) return;
    const width = question.options.length;
    const column = table.answers[at];
    if (column === undefined) return;
    const distribution = Array.from(column.subarray(row * width, (row + 1) * width));
    let best = 0;
    for (let option = 1; option < width; option += 1) {
      if ((distribution[option] ?? 0) > (distribution[best] ?? 0)) best = option;
    }
    answers.push({
      question: question.id,
      option: question.options[best] ?? "",
      probability: distribution[best] ?? 0,
      distribution,
    });
  });
  return answers;
}

/** The most a row's stated pay reaches: its maximum, or its minimum when only that is stated. */
function payReach(table: IndexTable, row: number): number {
  const min = table.payMin[row] ?? Number.NaN;
  const max = table.payMax[row] ?? Number.NaN;
  return Number.isNaN(max) ? min : Number.isNaN(min) ? max : Math.max(min, max);
}

function some(column: ListColumn, row: number, codes: ReadonlySet<number>): boolean {
  if (codes.size === 0) return false;
  for (let at = column.offsets[row] ?? 0; at < (column.offsets[row + 1] ?? 0); at += 1) {
    if (codes.has(column.values[at] ?? -1)) return true;
  }
  return false;
}

function forEachValue(column: ListColumn, row: number, visit: (code: number) => void): void {
  for (let at = column.offsets[row] ?? 0; at < (column.offsets[row + 1] ?? 0); at += 1) {
    visit(column.values[at] ?? -1);
  }
}

function increment(map: Map<number, number>, key: number): void {
  if (key >= 0) map.set(key, (map.get(key) ?? 0) + 1);
}
