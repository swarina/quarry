import { ATS_SOURCES, boardId, isValidSlug } from "@quarry/domain";
import type { BoardRef, SeedBoard } from "@quarry/storage/node";
import { parse } from "yaml";
import { z } from "zod";

const slug = z.string().refine(isValidSlug, "must be a URL-safe board slug");

const seedBoard = z.strictObject({
  source: z.enum(ATS_SOURCES),
  slug,
  company: z.string().trim().min(1),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/, "must be an ISO 3166-1 alpha-2 code")
    .nullable()
    .default(null),
});

const deniedBoard = z.strictObject({
  source: z.enum(ATS_SOURCES),
  slug,
  requested: z.iso.date(),
  reason: z.string().trim().min(1),
});

const seedsFile = z.strictObject({ boards: z.array(seedBoard) });
const denylistFile = z.strictObject({ boards: z.array(deniedBoard).nullable().default([]) });

export class SeedsError extends Error {
  override readonly name = "SeedsError";
}

/** Parses `seeds/boards.yaml`. Throws `SeedsError` naming every problem. */
export function parseSeeds(text: string): SeedBoard[] {
  const boards = parseYaml(seedsFile, text, "boards.yaml").boards;
  rejectDuplicates(boards, "boards.yaml");
  return boards;
}

/** Parses `seeds/denylist.yaml`: boards whose companies asked to be excluded. */
export function parseDenylist(text: string): BoardRef[] {
  const boards = parseYaml(denylistFile, text, "denylist.yaml").boards ?? [];
  rejectDuplicates(boards, "denylist.yaml");
  return boards.map(({ source, slug: value }) => ({ source, slug: value }));
}

function parseYaml<T>(schema: z.ZodType<T>, text: string, file: string): T {
  let data: unknown;
  try {
    data = parse(text);
  } catch (error) {
    throw new SeedsError(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = schema.safeParse(data);
  if (!result.success) throw new SeedsError(`${file}:\n${z.prettifyError(result.error)}`);
  return result.data;
}

function rejectDuplicates(boards: readonly BoardRef[], file: string): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const board of boards) {
    const id = boardId(board.source, board.slug);
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  if (duplicates.size > 0) {
    throw new SeedsError(`${file}: listed more than once: ${[...duplicates].sort().join(", ")}`);
  }
}
