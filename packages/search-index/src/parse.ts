import {
  BUILD_ID,
  INDEX_FORMAT,
  LINKS_PATH,
  type Links,
  type ListColumnFile,
  type Manifest,
  MIN_ID_LENGTH,
  PROBABILITY_SCALE,
  REGIONS,
  type RegionId,
  SHA256,
  SHARD_PATH,
  type Shard,
  type ShardEntry,
  type ShardQuestion,
} from "./format.ts";

/**
 * Checks index files a reader fetched, without a validation library: the browser loads this
 * code, and shipping one to re-check files we generated ourselves and name by content hash
 * would cost more than every shard it guards. `schema.ts` holds zod schemas of the same
 * shapes, which the build and its tests use.
 *
 * Every function throws `IndexFormatError` naming the field at fault, so a bad file is loud
 * rather than a page that quietly shows the wrong thing.
 */
export class IndexFormatError extends Error {
  override readonly name = "IndexFormatError";
}

function fail(what: string): never {
  throw new IndexFormatError(what);
}

function object(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) fail(`${what} is not an array`);
  return value;
}

function text(value: unknown, what: string, pattern?: RegExp): string {
  if (typeof value !== "string") fail(`${what} is not a string`);
  if (pattern !== undefined && !pattern.test(value)) fail(`${what} is not in the expected form`);
  return value;
}

function whole(value: unknown, what: string, least = 0): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < least) {
    fail(`${what} is not a whole number of at least ${least}`);
  }
  return value;
}

function format(value: unknown, what: string): number {
  const found = whole(value, `${what} format`);
  if (found !== INDEX_FORMAT)
    fail(`${what} is format ${found}, and this reader reads ${INDEX_FORMAT}`);
  return found;
}

function region(value: unknown, what: string): RegionId {
  const found = text(value, what);
  if (!REGIONS.some((entry) => entry.id === found)) fail(`${what} names no region: ${found}`);
  return found as RegionId;
}

/** A column of whole numbers, each at least `least`. */
function numbers(value: unknown, what: string, least = 0): number[] {
  return array(value, what).map((entry, index) => whole(entry, `${what}[${index}]`, least));
}

/** A column that may hold nulls, such as pay or the day a posting appeared. */
function nullableNumbers(value: unknown, what: string): (number | null)[] {
  return array(value, what).map((entry, index) => {
    if (entry === null) return null;
    if (typeof entry !== "number" || !Number.isFinite(entry))
      fail(`${what}[${index}] is not a number`);
    return entry;
  });
}

function flags(value: unknown, what: string): (0 | 1)[] {
  return array(value, what).map((entry, index) => {
    if (entry !== 0 && entry !== 1) fail(`${what}[${index}] is not 0 or 1`);
    return entry;
  });
}

function strings(value: unknown, what: string, pattern?: RegExp): string[] {
  return array(value, what).map((entry, index) => text(entry, `${what}[${index}]`, pattern));
}

function questions(value: unknown, what: string): ShardQuestion[] {
  return array(value, what).map((entry, index) => {
    const where = `${what}[${index}]`;
    const found = object(entry, where);
    const kind = text(found["kind"], `${where}.kind`);
    if (kind !== "choice" && kind !== "score" && kind !== "noul")
      fail(`${where}.kind names no answer kind: ${kind}`);
    const options = strings(found["options"], `${where}.options`);
    if (options.length < 2) fail(`${where}.options has fewer than two options`);
    if (new Set(options).size !== options.length) fail(`${where}.options repeats an option`);
    const labels = strings(found["labels"], `${where}.labels`);
    if (labels.length !== options.length)
      fail(`${where}.labels has ${labels.length} labels for ${options.length} options`);
    return {
      id: text(found["id"], `${where}.id`),
      version: whole(found["version"], `${where}.version`, 1),
      about: text(found["about"], `${where}.about`),
      kind,
      options,
      labels,
    };
  });
}

function listColumn(value: unknown, what: string): ListColumnFile {
  const found = object(value, what);
  return {
    counts: numbers(found["counts"], `${what}.counts`),
    values: numbers(found["values"], `${what}.values`),
  };
}

function fileEntry(value: Record<string, unknown>, what: string, path: RegExp) {
  return {
    path: text(value["path"], `${what}.path`, path),
    rows: whole(value["rows"], `${what}.rows`),
    bytes: whole(value["bytes"], `${what}.bytes`, 1),
    gzipBytes: whole(value["gzipBytes"], `${what}.gzipBytes`, 1),
    sha256: text(value["sha256"], `${what}.sha256`, SHA256),
  };
}

export function parseManifest(value: unknown): Manifest {
  const found = object(value, "manifest");
  format(found["format"], "manifest");
  const idLength = whole(found["idLength"], "manifest.idLength", MIN_ID_LENGTH);
  if (idLength > 16) fail("manifest.idLength is longer than an id");
  return {
    format: INDEX_FORMAT,
    build: text(found["build"], "manifest.build", BUILD_ID),
    builtAt: text(found["builtAt"], "manifest.builtAt"),
    facetsVersion: whole(found["facetsVersion"], "manifest.facetsVersion", 1),
    postings: whole(found["postings"], "manifest.postings"),
    idLength,
    regions: array(found["regions"], "manifest.regions").map((entry, index) => {
      const what = `manifest.regions[${index}]`;
      const found = object(entry, what);
      return {
        id: region(found["id"], `${what}.id`),
        name: text(found["name"], `${what}.name`),
        rows: whole(found["rows"], `${what}.rows`),
        shards: array(found["shards"], `${what}.shards`).map((shard, at): ShardEntry => {
          const where = `${what}.shards[${at}]`;
          const entry = object(shard, where);
          return {
            ...fileEntry(entry, where, SHARD_PATH),
            links: fileEntry(
              object(entry["links"], `${where}.links`),
              `${where}.links`,
              LINKS_PATH,
            ),
          };
        }),
      };
    }),
  };
}

export function parseLinks(value: unknown): Links {
  const found = object(value, "links");
  format(found["format"], "links");
  return {
    format: INDEX_FORMAT,
    region: region(found["region"], "links.region"),
    part: whole(found["part"], "links.part"),
    rows: whole(found["rows"], "links.rows"),
    urls: strings(found["urls"], "links.urls"),
  };
}

export function parseShard(value: unknown): Shard {
  const found = object(value, "shard");
  format(found["format"], "shard");
  const dictionaries = object(found["dictionaries"], "shard.dictionaries");
  const columns = object(found["columns"], "shard.columns");
  const pair = (entry: unknown, what: string): [string, string] => {
    const values = array(entry, what);
    if (values.length !== 2) fail(`${what} is not a pair`);
    return [text(values[0], `${what}[0]`), text(values[1], `${what}[1]`)];
  };
  return {
    format: INDEX_FORMAT,
    region: region(found["region"], "shard.region"),
    part: whole(found["part"], "shard.part"),
    rows: whole(found["rows"], "shard.rows"),
    questions: questions(found["questions"], "shard.questions"),
    dictionaries: {
      company: strings(dictionaries["company"], "shard.dictionaries.company"),
      location: strings(dictionaries["location"], "shard.dictionaries.location"),
      country: strings(dictionaries["country"], "shard.dictionaries.country", /^[A-Z]{2}$/),
      division: array(dictionaries["division"], "shard.dictionaries.division").map((entry, index) =>
        pair(entry, `shard.dictionaries.division[${index}]`),
      ),
      city: array(dictionaries["city"], "shard.dictionaries.city").map((entry, index) => {
        const what = `shard.dictionaries.city[${index}]`;
        const values = array(entry, what);
        if (values.length !== 3) fail(`${what} is not an id, name, and country`);
        return [
          whole(values[0], `${what}[0]`),
          text(values[1], `${what}[1]`),
          text(values[2], `${what}[2]`),
        ] as const;
      }),
      department: strings(dictionaries["department"], "shard.dictionaries.department"),
      currency: strings(dictionaries["currency"], "shard.dictionaries.currency"),
    },
    columns: {
      id: strings(columns["id"], "shard.columns.id"),
      title: strings(columns["title"], "shard.columns.title"),
      company: numbers(columns["company"], "shard.columns.company", -1),
      location: listColumn(columns["location"], "shard.columns.location"),
      country: listColumn(columns["country"], "shard.columns.country"),
      division: listColumn(columns["division"], "shard.columns.division"),
      city: listColumn(columns["city"], "shard.columns.city"),
      workplace: numbers(columns["workplace"], "shard.columns.workplace", -1),
      anywhere: flags(columns["anywhere"], "shard.columns.anywhere"),
      inferred: flags(columns["inferred"], "shard.columns.inferred"),
      employment: numbers(columns["employment"], "shard.columns.employment"),
      department: numbers(columns["department"], "shard.columns.department", -1),
      payMin: nullableNumbers(columns["payMin"], "shard.columns.payMin"),
      payMax: nullableNumbers(columns["payMax"], "shard.columns.payMax"),
      currency: numbers(columns["currency"], "shard.columns.currency", -1),
      posted: nullableNumbers(columns["posted"], "shard.columns.posted"),
      answers: array(columns["answers"], "shard.columns.answers").map((entry, index) => {
        const what = `shard.columns.answers[${index}]`;
        return numbers(entry, what).map((value, at) => {
          if (value > PROBABILITY_SCALE) fail(`${what}[${at}] is a probability above 1`);
          return value;
        });
      }),
      answered: numbers(columns["answered"], "shard.columns.answered"),
    },
  };
}
