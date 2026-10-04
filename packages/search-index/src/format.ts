import type { Workplace } from "@quarry/domain";
import type { EmploymentType } from "@quarry/facets";

/**
 * The shapes of the index files, as types and constants only. Nothing here imports a
 * validation library, because the browser loads this module and pays for every byte of it;
 * `schema.ts` holds zod schemas of the same shapes for the build and its tests, and
 * `table.ts` checks what it reads by hand.
 */

/** Version of the file formats below; readers refuse others. */
export const INDEX_FORMAT = 4;

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

export const SHARD_PATH = /^[0-9a-f]{12}\/shards\/[a-z-]+-\d+\.json$/;
export const LINKS_PATH = /^[0-9a-f]{12}\/links\/[a-z-]+-\d+\.json$/;
export const BUILD_ID = /^[0-9a-f]{12}$/;
export const SHA256 = /^[0-9a-f]{64}$/;

interface FileEntry {
  readonly rows: number;
  readonly bytes: number;
  readonly gzipBytes: number;
  readonly sha256: string;
}

export interface ShardEntry extends FileEntry {
  /** Relative to the manifest. */
  readonly path: string;
  /** The apply links for these rows, in the same order; fetched only when one is needed. */
  readonly links: FileEntry & { readonly path: string };
}

export interface Manifest {
  readonly format: number;
  /** Content hash of the build: its shards and the rules that made them. */
  readonly build: string;
  readonly builtAt: string;
  readonly facetsVersion: number;
  /** Version of the rules that read stored answers into the probabilities below. */
  readonly answersVersion: number;
  /** Distinct postings in the build (a posting in two regions counts once). */
  readonly postings: number;
  /** Length of the posting id prefixes in the shards. */
  readonly idLength: number;
  readonly regions: readonly {
    readonly id: RegionId;
    readonly name: string;
    readonly rows: number;
    readonly shards: readonly ShardEntry[];
  }[];
}

/**
 * The apply links of one shard's rows, in the same order. They are kept out of the shard
 * because searching never needs them: only opening a posting does.
 */
export interface Links {
  readonly format: number;
  readonly region: RegionId;
  readonly part: number;
  readonly rows: number;
  readonly urls: readonly string[];
}

/** A column of lists, as counts per row and the values in row order. */
export interface ListColumnFile {
  readonly counts: readonly number[];
  readonly values: readonly number[];
}

/**
 * A standard question a shard holds answers to. Carried inside the shard rather than looked up,
 * so the browser reads answers without importing the question registry, and with it the SDK.
 *
 * The wording version matters to a reader: answers under an older wording mean something else,
 * so a shard says which wording produced the ones it holds.
 */
export interface ShardQuestion {
  readonly id: string;
  readonly version: number;
  /** What this question answers, for the site to label a filter with. */
  readonly about: string;
  readonly kind: "choice" | "score" | "noul";
  /** Option ids, in the order probabilities are stored in. */
  readonly options: readonly string[];
  /** What each option means, in the same order. */
  readonly labels: readonly string[];
}

/** Probabilities are stored in hundredths, which is the precision Jev publishes. */
export const PROBABILITY_SCALE = 100;

/**
 * The probability at which an answer is taken to be an option unless a search says otherwise:
 * more likely than not. Deliberately not a confident-sounding 0.9, since the honest default is
 * the point where an option becomes the likelier reading.
 */
export const DEFAULT_ANSWER_THRESHOLD = 50;

export interface Shard {
  readonly format: number;
  readonly region: RegionId;
  readonly part: number;
  readonly rows: number;
  /** The questions the answer columns below are for, in the same order. */
  readonly questions: readonly ShardQuestion[];
  readonly dictionaries: {
    readonly company: readonly string[];
    readonly location: readonly string[];
    readonly country: readonly string[];
    /** "US.CA" and its name. */
    readonly division: readonly (readonly [string, string])[];
    /** GeoNames id, name, country. */
    readonly city: readonly (readonly [number, string, string])[];
    readonly department: readonly string[];
    readonly currency: readonly string[];
  };
  readonly columns: {
    readonly id: readonly string[];
    readonly title: readonly string[];
    readonly company: readonly number[];
    readonly location: ListColumnFile;
    readonly country: ListColumnFile;
    readonly division: ListColumnFile;
    readonly city: ListColumnFile;
    /** An index into WORKPLACE_CODES, or -1. */
    readonly workplace: readonly number[];
    readonly anywhere: readonly (0 | 1)[];
    /** 1 when the only place is the company's home country, inferred rather than stated. */
    readonly inferred: readonly (0 | 1)[];
    /** A bit per EMPLOYMENT_CODES entry. */
    readonly employment: readonly number[];
    readonly department: readonly number[];
    readonly payMin: readonly (number | null)[];
    readonly payMax: readonly (number | null)[];
    readonly currency: readonly number[];
    /** Days since 1970-01-01 (UTC) when published, or first seen. */
    readonly posted: readonly (number | null)[];
    /**
     * Per question, in `questions` order: every row's probability for every option, in
     * hundredths, flattened row by row. So question `q`'s probability for row `r`'s option `o`
     * is `answers[q][r * options.length + o]`.
     *
     * A row with no answer is left as zeros, which costs almost nothing once gzipped, and
     * `answered` is what says whether to read them. Storing the whole distribution rather than
     * only the likeliest option is what lets a search ask for the probability of a set of
     * options ("remote or hybrid") instead of only the one the model happened to pick.
     */
    readonly answers: readonly (readonly number[])[];
    /** A bit per question, in `questions` order: 1 when this row holds that answer. */
    readonly answered: readonly number[];
  };
}
