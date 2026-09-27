import type { AtsSource, NormalizedPosting } from "@quarry/domain";
import type { z } from "zod";

/** Where to fetch a board's listing. `host` is what politeness limits are keyed on. */
export interface ListingRequest {
  readonly url: string;
  readonly host: string;
}

/**
 * One job in a listing. A job whose fields don't match the schema is still listed (its id was
 * readable), so it counts as present even though its content can't be used.
 */
export type ListedItem =
  | {
      readonly kind: "posting";
      readonly externalId: string;
      readonly posting: NormalizedPosting;
      readonly raw: unknown;
    }
  | {
      readonly kind: "invalid";
      readonly externalId: string;
      readonly problem: string;
      readonly raw: unknown;
    };

export interface ParsedListing {
  /** Every publicly listed job, once per external id, in listing order. */
  readonly items: readonly ListedItem[];
  /** Jobs that appeared more than once; only the first copy is kept. */
  readonly duplicates: number;
  /** Jobs the ATS returned but marks as not publicly listed. They are left out. */
  readonly unlisted: number;
}

/**
 * The response is not a listing this adapter understands, or a job has no readable id. Either
 * way no job's presence can be trusted, so the whole crawl counts as failed.
 */
export class AtsSchemaError extends Error {
  override readonly name = "AtsSchemaError";
  readonly source: AtsSource;

  constructor(source: AtsSource, message: string) {
    super(`${source}: ${message}`);
    this.source = source;
  }
}

/** The result of mapping one job: a posting, a schema problem, or a job hidden from listings. */
export type JobResult =
  | { readonly kind: "posting"; readonly posting: NormalizedPosting }
  | { readonly kind: "invalid"; readonly problem: string }
  | { readonly kind: "unlisted" };

/** What each ATS module provides. */
export interface AtsAdapter {
  readonly host: string;
  /** Path and query of the listing endpoint, including full job content. */
  listingPath(slug: string): string;
  /** The jobs array of a listing response. Throws `AtsSchemaError` for anything else. */
  jobs(body: unknown): readonly unknown[];
  /** The job's id as a string. Throws `AtsSchemaError` when it's missing or malformed. */
  externalId(job: unknown): string;
  mapJob(job: unknown, externalId: string): JobResult;
}

/** A short, loggable summary of the first few schema issues. */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("; ");
}
