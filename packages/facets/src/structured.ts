import type { NormalizedPosting, PayInterval, Workplace } from "@quarry/domain";
import { locatePosting, type PostingLocation } from "@quarry/places";

/**
 * Version of the derivation below. Bump it when the same posting can get different facets, so
 * artifacts built from facets (the search index) say which rules made them.
 */
export const STRUCTURED_FACETS_VERSION = 2;

export const EMPLOYMENT_TYPES = [
  "full-time",
  "part-time",
  "contract",
  "internship",
  "temporary",
] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

/** Pay as a yearly range in the stated currency. Currencies are converted later, not here. */
export interface AnnualPay {
  readonly min: number | null;
  readonly max: number | null;
  /** ISO 4217. */
  readonly currency: string;
  /** The period the ATS stated the pay for, before it was converted to a year. */
  readonly statedPer: PayInterval;
}

/** The fields of a posting that structured facets read; the description is not one of them. */
export type FacetInput = Pick<
  NormalizedPosting,
  | "locations"
  | "places"
  | "country"
  | "workplace"
  | "employmentType"
  | "salary"
  | "department"
  | "publishedAt"
>;

/** The facets a posting gets without Jev: from structured fields and location labels. */
export interface StructuredFacets {
  readonly location: PostingLocation;
  /** The countries of the location's places, in order, without repeats. */
  readonly countries: readonly string[];
  /** The work arrangement the ATS states in a field, else the one its labels state. */
  readonly workplace: Workplace | null;
  /** Every employment type the stated label names ("Full Time/Part Time" names two). */
  readonly employmentTypes: readonly EmploymentType[];
  readonly pay: AnnualPay | null;
  readonly department: string | null;
  /** When the ATS says the job was published, in epoch milliseconds. */
  readonly publishedAt: number | null;
}

/** How many of each period make a year, for pay. A day counts as a working day. */
const PER_YEAR: Readonly<Record<PayInterval, number>> = {
  year: 1,
  month: 12,
  week: 52,
  day: 260,
  hour: 2080,
};

/** Employment types by the words labels use for them, in English and a few other languages. */
const EMPLOYMENT_WORDS: readonly (readonly [EmploymentType, RegExp])[] = [
  ["full-time", /\bfull ?time\b/],
  ["part-time", /\b(?:part ?time|working student|werkstudent)\b/],
  ["contract", /\b(?:contract|contractor|freelance|freelancer|project based)\b/],
  [
    "internship",
    /\b(?:intern|internship|trainee|apprentice|apprenticeship|alternance|stage|stagiaire)\b/,
  ],
  ["temporary", /\b(?:temporary|temp|fixed term|short term|cdd)\b/],
];

/**
 * Words for an ordinary employee ("Permanent", "Employee", the French CDI and cadre). They mean
 * full-time only when the label names no type itself: "Part Time Employee" is part-time.
 */
const EMPLOYEE_WORDS = /\b(?:permanent|employee|cdi|cadre)\b/;

/**
 * A posting's structured facets. `board.country` is the company's home country, the weakest
 * hint for reading its location labels.
 */
export function deriveFacets(
  posting: FacetInput,
  board: { readonly country: string | null },
): StructuredFacets {
  const location = locatePosting(posting, board.country);
  return {
    location,
    countries: [...new Set(location.places.map((place) => place.country))],
    workplace: posting.workplace ?? location.workplace,
    employmentTypes: employmentTypes(posting.employmentType),
    pay: annualPay(posting),
    department: posting.department,
    publishedAt: posting.publishedAt,
  };
}

/** The employment types a stated label names: "FullTime", "Full-time: Remote", "CDI". */
export function employmentTypes(label: string | null): EmploymentType[] {
  if (label === null) return [];
  const words = label
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z]+/g, " ");
  const types = EMPLOYMENT_WORDS.filter(([, pattern]) => pattern.test(words)).map(([type]) => type);
  return types.length === 0 && EMPLOYEE_WORDS.test(words) ? ["full-time"] : types;
}

/** The stated salary as a yearly range, or null without one. */
export function annualPay(posting: Pick<NormalizedPosting, "salary">): AnnualPay | null {
  const { salary } = posting;
  if (salary === null) return null;
  const factor = PER_YEAR[salary.interval];
  const yearly = (amount: number | null) => (amount === null ? null : Math.round(amount * factor));
  return {
    min: yearly(salary.min),
    max: yearly(salary.max),
    currency: salary.currency,
    statedPer: salary.interval,
  };
}
