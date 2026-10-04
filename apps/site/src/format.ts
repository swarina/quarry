import type { Workplace } from "@quarry/domain";
import type { EmploymentType } from "@quarry/facets";
import type { ResultRow } from "@quarry/search-index";

const DAY_MS = 24 * 60 * 60 * 1000;

export const WORKPLACE_NAMES: Readonly<Record<Workplace, string>> = {
  remote: "Remote",
  hybrid: "Hybrid",
  onsite: "On site",
};

export const EMPLOYMENT_NAMES: Readonly<Record<EmploymentType, string>> = {
  "full-time": "Full time",
  "part-time": "Part time",
  contract: "Contract",
  internship: "Internship",
  temporary: "Temporary",
};

/**
 * The bands the README promises results are grouped into: likely, maybe, unlikely. A band is
 * shown instead of a bare percentage because a calibrated probability is easy to over-read: 71%
 * and 69% are the same claim, and showing them as different numbers invites a precision the
 * model does not have. The exact figure is still there, in the title text.
 *
 * Where the cuts sit is a product decision resting on measurement that does not exist yet. They
 * are provisional until the questions' accuracy and calibration are measured, and that work
 * should move them rather than leave them because they shipped once.
 */
const UNLIKELY = { id: "unlikely", name: "unlikely", least: 0 } as const;

export const CONFIDENCE_BANDS = [
  { id: "likely", name: "likely", least: 70 },
  { id: "maybe", name: "maybe", least: 40 },
  UNLIKELY,
] as const;

export type ConfidenceBand = (typeof CONFIDENCE_BANDS)[number];

/** The band a probability in hundredths falls in; the lowest starts at 0, so there is always one. */
export function confidenceBand(probability: number): ConfidenceBand {
  for (const band of CONFIDENCE_BANDS) {
    if (probability >= band.least) return band;
  }
  return UNLIKELY;
}

/** A country code as its name in the reader's language, falling back to the code itself. */
export function countryName(code: string, locale?: string): string {
  try {
    return new Intl.DisplayNames([locale ?? "en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

export function number(value: number, locale?: string): string {
  return value.toLocaleString(locale ?? "en-US");
}

/** Pay as a range in its stated currency; currencies are never converted (ADR-0007). */
export function pay(row: ResultRow, locale?: string): string | null {
  if (row.pay === null) return null;
  const money = (amount: number) =>
    amount.toLocaleString(locale ?? "en-US", {
      style: "currency",
      currency: row.pay?.currency ?? "USD",
      maximumFractionDigits: 0,
    });
  const { min, max } = row.pay;
  if (min !== null && max !== null && min !== max) return `${money(min)} to ${money(max)}`;
  const one = min ?? max;
  return one === null ? null : `${money(one)} a year`;
}

/** How long ago a posting was published, or first seen when the board states no date. */
export function posted(postedDay: number | null, now: number, locale?: string): string {
  if (postedDay === null) return "date not stated";
  const days = Math.max(0, Math.round(now / DAY_MS - postedDay));
  try {
    const relative = new Intl.RelativeTimeFormat(locale ?? "en", { numeric: "auto" });
    if (days < 30) return relative.format(-days, "day");
    if (days < 365) return relative.format(-Math.round(days / 30), "month");
    return relative.format(-Math.round(days / 365), "year");
  } catch {
    return `${days} days ago`;
  }
}

/** Naming more countries than this says less than counting them: "EMEA" reads as 53 of them. */
const MANY = 4;

/** Where a posting is, as the places we read rather than the label the board wrote. */
export function where(row: ResultRow, locale?: string): string {
  if (row.anywhere) return "Anywhere";
  const cities = [...new Set(row.cities)].filter((city) => city.length > 0);
  const countries = [...new Set(row.countries)];
  if (cities.length === 0 && countries.length > MANY) {
    return `${number(countries.length, locale)} countries`;
  }
  const places = cities.length > 0 ? cities : countries.map((code) => countryName(code, locale));
  if (places.length === 0) return "Location not stated";
  const shown = places.slice(0, 3);
  const rest = places.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}
