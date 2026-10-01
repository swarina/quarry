import { z } from "zod";
import {
  BUILD_ID,
  INDEX_FORMAT,
  LINKS_PATH,
  type Links,
  type Manifest,
  MIN_ID_LENGTH,
  REGIONS,
  SHA256,
  SHARD_PATH,
  type Shard,
} from "./format.ts";

/**
 * zod schemas for the index files, for the build and its tests. Readers do not use these: the
 * browser would pay for the whole library to re-check files it fetched by content hash, so
 * `table.ts` checks what it reads by hand. Each schema is typed against the interface in
 * `format.ts`, so the two cannot drift apart without a type error.
 */

const region = z.enum(REGIONS.map((entry) => entry.id));

const fileEntry = {
  rows: z.int().nonnegative(),
  bytes: z.int().positive(),
  gzipBytes: z.int().positive(),
  sha256: z.string().regex(SHA256),
};

const shardEntry = z.strictObject({
  path: z.string().regex(SHARD_PATH),
  ...fileEntry,
  links: z.strictObject({ path: z.string().regex(LINKS_PATH), ...fileEntry }),
});

export const manifestSchema: z.ZodType<Manifest> = z.strictObject({
  format: z.literal(INDEX_FORMAT),
  build: z.string().regex(BUILD_ID),
  builtAt: z.iso.datetime(),
  facetsVersion: z.int().positive(),
  postings: z.int().nonnegative(),
  idLength: z.int().min(MIN_ID_LENGTH).max(16),
  regions: z.array(
    z.strictObject({
      id: region,
      name: z.string(),
      rows: z.int().nonnegative(),
      shards: z.array(shardEntry),
    }),
  ),
});

export const linksSchema: z.ZodType<Links> = z.strictObject({
  format: z.literal(INDEX_FORMAT),
  region,
  part: z.int().nonnegative(),
  rows: z.int().nonnegative(),
  urls: z.array(z.string()),
});

const listColumn = z.strictObject({
  counts: z.array(z.int().nonnegative()),
  values: z.array(z.int().nonnegative()),
});
const codes = z.array(z.int().min(-1));
const numbers = z.array(z.number().nullable());
const flags = z.array(z.union([z.literal(0), z.literal(1)]));

export const shardSchema: z.ZodType<Shard> = z.strictObject({
  format: z.literal(INDEX_FORMAT),
  region,
  part: z.int().nonnegative(),
  rows: z.int().nonnegative(),
  dictionaries: z.strictObject({
    company: z.array(z.string()),
    location: z.array(z.string()),
    country: z.array(z.string().regex(/^[A-Z]{2}$/)),
    division: z.array(z.tuple([z.string(), z.string()])),
    city: z.array(z.tuple([z.int(), z.string(), z.string()])),
    department: z.array(z.string()),
    currency: z.array(z.string()),
  }),
  columns: z.strictObject({
    id: z.array(z.string()),
    title: z.array(z.string()),
    company: codes,
    location: listColumn,
    country: listColumn,
    division: listColumn,
    city: listColumn,
    workplace: codes,
    anywhere: flags,
    inferred: flags,
    employment: z.array(z.int().nonnegative()),
    department: codes,
    payMin: numbers,
    payMax: numbers,
    currency: codes,
    posted: numbers,
  }),
});
