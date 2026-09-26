import { type AtsSource, isAtsSource } from "./ats-source.ts";
import { base32 } from "./base32.ts";
import type { Brand } from "./brand.ts";
import { sha256 } from "./hash.ts";

/** `<source>:<slug in lowercase>`, for example `greenhouse:stripe`. */
export type BoardId = Brand<string, "BoardId">;

/** 16 lowercase base32 characters derived from the board id and the ATS's job id. */
export type PostingId = Brand<string, "PostingId">;

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const POSTING_ID = /^[a-z2-7]{16}$/;

/** Board slugs as the ATS URLs use them: letters, digits, dots, hyphens, and underscores. */
export function isValidSlug(slug: string): boolean {
  return SLUG.test(slug);
}

/**
 * The id of a board. Slugs are compared case-insensitively, so `Notion` and `notion` on the
 * same source are one board. Throws a `RangeError` for a slug that is not URL-safe.
 */
export function boardId(source: AtsSource, slug: string): BoardId {
  if (!isValidSlug(slug)) throw new RangeError(`Invalid board slug: ${JSON.stringify(slug)}`);
  return `${source}:${slug.toLowerCase()}` as BoardId;
}

/** Parses a board id back into its source and lowercase slug, or returns `undefined`. */
export function parseBoardId(value: string): { source: AtsSource; slug: string } | undefined {
  const separator = value.indexOf(":");
  if (separator < 0) return undefined;
  const source = value.slice(0, separator);
  const slug = value.slice(separator + 1);
  if (!isAtsSource(source) || !isValidSlug(slug) || slug !== slug.toLowerCase()) return undefined;
  return { source, slug };
}

/**
 * The id of a posting: the first 80 bits of SHA-256 over `<board id>:<external id>`, in base32.
 * It is deterministic, so every crawl of the same job updates the same row, and it is short
 * enough for URLs and the search index.
 */
export async function postingId(board: BoardId, externalId: string): Promise<PostingId> {
  if (externalId.length === 0) throw new RangeError("External id must not be empty");
  return base32(await sha256(`${board}:${externalId}`)).slice(0, 16) as PostingId;
}

export function isPostingId(value: string): value is PostingId {
  return POSTING_ID.test(value);
}
