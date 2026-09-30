import type { Workplace } from "@quarry/domain";
import type { EmploymentType } from "@quarry/facets";
import { z } from "zod";

/** Version of the file formats below; readers refuse others. */
export const INDEX_FORMAT = 3;

/**
 * Size budgets (ADR-0007): a shard downloads quickly on a phone, the manifest (fetched on every
 * visit) stays small, and a build stays well under the 20,000 files a Worker version allows.
 */
export const BUDGETS: Budgets = {
  shardGzipBytes: 600 * 1024,
  linksGzipBytes: 600 * 1024,
  manifestBytes: 20 * 1024,
  files: 5_000,
};

export interface Budgets {
  readonly shardGzipBytes: number;
  /** A links file is fetched after results are shown, so it may be as large as a shard. */
  readonly linksGzipBytes: number;
  readonly manifestBytes: number;
  readonly files: number;
}

/** Rows per shard file; a region with more is split into parts. */
export const ROWS_PER_PART = 8_000;

/** Shortest posting id prefix used; longer when prefixes would collide. */
export const MIN_ID_LENGTH = 10;

/** Codes for enums in shards: the index of the value in these lists. */
export const WORKPLACE_CODES: readonly Workplace[] = ["remote", "hybrid", "onsite"];
export const EMPLOYMENT_CODES: readonly EmploymentType[] = [
  "full-time",
  "part-time",
  "contract",
  "internship",
  "temporary",
];

/**
 * Shards are split by where postings are: continents, plus postings that can be done from
 * anywhere and postings no label or field places. A posting in several is in each.
 */
export const REGIONS = [
  { id: "north-america", name: "North America", continent: "NA" },
  { id: "south-america", name: "South America", continent: "SA" },
  { id: "europe", name: "Europe", continent: "EU" },
  { id: "africa", name: "Africa", continent: "AF" },
  { id: "asia", name: "Asia", continent: "AS" },
  { id: "oceania", name: "Oceania", continent: "OC" },
  { id: "anywhere", name: "Anywhere", continent: null },
  { id: "unplaced", name: "Location not stated", continent: null },
] as const;
export type RegionId = (typeof REGIONS)[number]["id"];

const fileEntry = {
  rows: z.int().nonnegative(),
  bytes: z.int().positive(),
  gzipBytes: z.int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
};

const shardEntry = z.strictObject({
  /** Relative to the manifest. */
  path: z.string().regex(/^[0-9a-f]{12}\/shards\/[a-z-]+-\d+\.json$/),
  ...fileEntry,
  /** The apply links for these rows, in the same order; fetched only when one is needed. */
  links: z.strictObject({
    path: z.string().regex(/^[0-9a-f]{12}\/links\/[a-z-]+-\d+\.json$/),
    ...fileEntry,
  }),
});

export const manifestSchema = z.strictObject({
  format: z.literal(INDEX_FORMAT),
  /** Content hash of the build: its shards and the rules that made them. */
  build: z.string().regex(/^[0-9a-f]{12}$/),
  builtAt: z.iso.datetime(),
  facetsVersion: z.int().positive(),
  /** Distinct postings in the build (a posting in two regions counts once). */
  postings: z.int().nonnegative(),
  /** Length of the posting id prefixes in the shards. */
  idLength: z.int().min(MIN_ID_LENGTH).max(16),
  regions: z.array(
    z.strictObject({
      id: z.enum(REGIONS.map((region) => region.id)),
      name: z.string(),
      rows: z.int().nonnegative(),
      shards: z.array(shardEntry),
    }),
  ),
});
export type Manifest = z.infer<typeof manifestSchema>;
export type ShardEntry = z.infer<typeof shardEntry>;

/**
 * The apply links of one shard's rows, in the same order. They are kept out of the shard
 * because searching never needs them: only opening a posting does.
 */
export const linksSchema = z.strictObject({
  format: z.literal(INDEX_FORMAT),
  region: z.enum(REGIONS.map((region) => region.id)),
  part: z.int().nonnegative(),
  rows: z.int().nonnegative(),
  urls: z.array(z.string()),
});
export type Links = z.infer<typeof linksSchema>;

/** A column of lists, as counts per row and the values in row order. */
const listColumn = z.strictObject({
  counts: z.array(z.int().nonnegative()),
  values: z.array(z.int().nonnegative()),
});
const codes = z.array(z.int().min(-1));
const numbers = z.array(z.number().nullable());

export const shardSchema = z.strictObject({
  format: z.literal(INDEX_FORMAT),
  region: z.enum(REGIONS.map((region) => region.id)),
  part: z.int().nonnegative(),
  rows: z.int().nonnegative(),
  dictionaries: z.strictObject({
    company: z.array(z.string()),
    location: z.array(z.string()),
    country: z.array(z.string().regex(/^[A-Z]{2}$/)),
    /** "US.CA" and its name. */
    division: z.array(z.tuple([z.string(), z.string()])),
    /** GeoNames id, name, country. */
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
    /** An index into WORKPLACE_CODES, or -1. */
    workplace: codes,
    anywhere: z.array(z.union([z.literal(0), z.literal(1)])),
    /** 1 when the only place is the company's home country, inferred rather than stated. */
    inferred: z.array(z.union([z.literal(0), z.literal(1)])),
    /** A bit per EMPLOYMENT_CODES entry. */
    employment: z.array(z.int().nonnegative()),
    department: codes,
    payMin: numbers,
    payMax: numbers,
    currency: codes,
    /** Days since 1970-01-01 (UTC) when published, or first seen. */
    posted: numbers,
  }),
});
export type Shard = z.infer<typeof shardSchema>;
