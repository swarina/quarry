import { contentHash } from "./hash.ts";
import { htmlToText } from "./html-text.ts";

/** Work arrangement as an ATS declares it in a structured field. */
export type Workplace = "remote" | "hybrid" | "onsite";

export type PayInterval = "year" | "month" | "week" | "day" | "hour";

/** A pay range an ATS states in structured fields. Either bound may be missing. */
export interface SalaryRange {
  readonly min: number | null;
  readonly max: number | null;
  /** ISO 4217 currency code. */
  readonly currency: string;
  readonly interval: PayInterval;
}

/**
 * A place an ATS states in a structured field, such as an office or a postal address. It is a
 * hint for reading location labels, which are often shorter ("London") or not places at all
 * ("Hybrid").
 */
export interface StatedPlace {
  /** The location label this place belongs to, when the ATS pairs them. */
  readonly label: string | null;
  /** The place as text, most specific part first: "San Francisco, California, United States". */
  readonly text: string;
}

/**
 * One job posting as an ATS lists it, mapped to a shape shared by every source. It holds only
 * what the ATS states in structured fields; nothing is inferred.
 */
export interface NormalizedPosting {
  /** The ATS's own id for the job. */
  readonly externalId: string;
  readonly title: string;
  /** The employer's public page for the posting. */
  readonly url: string;
  readonly applyUrl: string | null;
  /** Location labels exactly as the ATS lists them, primary first. */
  readonly locations: readonly string[];
  /**
   * Offices and addresses the ATS states alongside the labels. Not part of the content: a
   * posting's places can be refined without it counting as an edit.
   */
  readonly places: readonly StatedPlace[];
  /** ISO 3166-1 alpha-2 country, when the ATS states one. */
  readonly country: string | null;
  readonly workplace: Workplace | null;
  /** The employment type label as stated, for example `Full-time` or `FullTime`. */
  readonly employmentType: string | null;
  readonly department: string | null;
  readonly team: string | null;
  /** The posting language as the ATS states it (a BCP 47 tag). */
  readonly language: string | null;
  /** When the ATS says the job was published, in epoch milliseconds. */
  readonly publishedAt: number | null;
  readonly salary: SalaryRange | null;
  /** The posting body as HTML. */
  readonly descriptionHtml: string;
}

/**
 * The part of a posting that counts as its content. Links, dates, and markup are left out, so
 * a new tracking parameter or an ATS template change is not mistaken for an edit.
 */
export interface PostingContent {
  readonly title: string;
  readonly locations: readonly string[];
  readonly country: string | null;
  readonly workplace: Workplace | null;
  readonly employmentType: string | null;
  readonly department: string | null;
  readonly team: string | null;
  readonly salary: SalaryRange | null;
  readonly description: string;
}

export function postingContent(posting: NormalizedPosting): PostingContent {
  return {
    title: posting.title,
    locations: posting.locations,
    country: posting.country,
    workplace: posting.workplace,
    employmentType: posting.employmentType,
    department: posting.department,
    team: posting.team,
    salary: posting.salary,
    description: htmlToText(posting.descriptionHtml),
  };
}

/**
 * Hex SHA-256 of the posting's content. Two crawls produce the same hash exactly when the
 * content is unchanged, which is how edits are detected.
 */
export function postingContentHash(posting: NormalizedPosting): Promise<string> {
  return contentHash(postingContent(posting));
}
