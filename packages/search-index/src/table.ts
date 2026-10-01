import type { Workplace } from "@quarry/domain";
import type { EmploymentType } from "@quarry/facets";
import { EMPLOYMENT_CODES, type Manifest, type Shard, WORKPLACE_CODES } from "./format.ts";
import { parseLinks, parseManifest, parseShard } from "./parse.ts";

/** A column of lists: row `i`'s values are `values[offsets[i]]` up to `values[offsets[i + 1]]`. */
export interface ListColumn {
  readonly offsets: Int32Array;
  readonly values: Int32Array;
}

/**
 * Shards decoded into one table, ready for queries: every posting once (a posting in two loaded
 * regions appears in both shards), newest first, strings coded against one set of
 * dictionaries, numbers in typed arrays.
 */
export interface IndexTable {
  readonly manifest: Manifest;
  readonly size: number;
  readonly id: readonly string[];
  readonly title: readonly string[];
  /** Title and company, folded for search. */
  readonly searchText: readonly string[];
  readonly company: Int32Array;
  readonly location: ListColumn;
  readonly country: ListColumn;
  readonly division: ListColumn;
  readonly city: ListColumn;
  /** An index into WORKPLACE_CODES, or -1. */
  readonly workplace: Int8Array;
  readonly anywhere: Uint8Array;
  /** 1 when the only place is the company's home country, inferred rather than stated. */
  readonly inferred: Uint8Array;
  /** A bit per EMPLOYMENT_CODES entry. */
  readonly employment: Uint8Array;
  readonly department: Int32Array;
  /** NaN when not stated. */
  readonly payMin: Float64Array;
  readonly payMax: Float64Array;
  readonly currency: Int32Array;
  /** Days since 1970-01-01 (UTC), or -1. */
  readonly posted: Int32Array;
  readonly dictionaries: {
    readonly company: readonly string[];
    readonly location: readonly string[];
    readonly country: readonly string[];
    readonly division: readonly (readonly [id: string, name: string])[];
    readonly city: readonly (readonly [id: number, name: string, country: string])[];
    readonly department: readonly string[];
    readonly currency: readonly string[];
  };
}

/** Folds text for search: no accents, lowercase. */
export function searchFold(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * Validates a manifest and the shards the reader loaded (any regions of it), and decodes them
 * into one table. Throws when a file is not in this format.
 */
export function openIndex(manifestJson: unknown, shardJsons: readonly unknown[]): IndexTable {
  const manifest = parseManifest(manifestJson);
  const shards = shardJsons.map((json) => checkShard(parseShard(json)));
  const dictionaries = {
    company: coder<string>(),
    location: coder<string>(),
    country: coder<string>(),
    division: coder<string>(),
    city: coder<number>(),
    department: coder<string>(),
    currency: coder<string>(),
  };
  const divisionNames = new Map<string, string>();
  const cityRecords = new Map<number, readonly [number, string, string]>();

  // Every row once, then ordered newest first; ties broken by id so the order is stable.
  const rows: { shard: Shard; row: number; lists: Record<ListName, number> }[] = [];
  const seen = new Set<string>();
  for (const shard of shards) {
    for (const [id, name] of shard.dictionaries.division) divisionNames.set(id, name);
    for (const record of shard.dictionaries.city) cityRecords.set(record[0], record);
    const offsets = listOffsets(shard);
    for (let row = 0; row < shard.rows; row += 1) {
      const id = shard.columns.id[row] ?? "";
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push({ shard, row, lists: pick(offsets, row) });
    }
  }
  const posted = (entry: (typeof rows)[number]) => entry.shard.columns.posted[entry.row] ?? -1;
  rows.sort(
    (left, right) =>
      posted(right) - posted(left) ||
      compare(left.shard.columns.id[left.row] ?? "", right.shard.columns.id[right.row] ?? ""),
  );

  const size = rows.length;
  const table = {
    id: [] as string[],
    title: [] as string[],
    searchText: [] as string[],
    company: new Int32Array(size),
    workplace: new Int8Array(size),
    anywhere: new Uint8Array(size),
    inferred: new Uint8Array(size),
    employment: new Uint8Array(size),
    department: new Int32Array(size),
    payMin: new Float64Array(size),
    payMax: new Float64Array(size),
    currency: new Int32Array(size),
    posted: new Int32Array(size),
  };
  const lists = {
    location: listBuilder(),
    country: listBuilder(),
    division: listBuilder(),
    city: listBuilder(),
  };
  rows.forEach(({ shard, row, lists: starts }, index) => {
    const { columns, dictionaries: local } = shard;
    const recode = <T>(
      dictionary: ReturnType<typeof coder<T>>,
      values: readonly T[],
      code: number,
    ) => (code < 0 ? -1 : dictionary.code(values[code] as T));
    const company = local.company[columns.company[row] ?? -1] ?? "";
    table.id.push(columns.id[row] ?? "");
    table.title.push(columns.title[row] ?? "");
    table.searchText.push(searchFold(`${columns.title[row] ?? ""} ${company}`));
    table.company[index] = dictionaries.company.code(company);
    table.workplace[index] = columns.workplace[row] ?? -1;
    table.anywhere[index] = columns.anywhere[row] ?? 0;
    table.inferred[index] = columns.inferred[row] ?? 0;
    table.employment[index] = columns.employment[row] ?? 0;
    table.department[index] = recode(
      dictionaries.department,
      local.department,
      columns.department[row] ?? -1,
    );
    table.payMin[index] = columns.payMin[row] ?? Number.NaN;
    table.payMax[index] = columns.payMax[row] ?? Number.NaN;
    table.currency[index] = recode(
      dictionaries.currency,
      local.currency,
      columns.currency[row] ?? -1,
    );
    table.posted[index] = columns.posted[row] ?? -1;
    for (const name of LIST_NAMES) {
      const column = columns[name];
      const start = starts[name];
      const count = column.counts[row] ?? 0;
      const values: number[] = [];
      for (let at = start; at < start + count; at += 1) {
        const code = column.values[at] ?? -1;
        values.push(
          name === "city"
            ? dictionaries.city.code(local.city[code]?.[0] ?? -1)
            : name === "division"
              ? dictionaries.division.code(local.division[code]?.[0] ?? "")
              : dictionaries[name].code(local[name][code] ?? ""),
        );
      }
      lists[name].add(values);
    }
  });

  return {
    manifest,
    size,
    ...table,
    location: lists.location.done(),
    country: lists.country.done(),
    division: lists.division.done(),
    city: lists.city.done(),
    dictionaries: {
      company: dictionaries.company.values,
      location: dictionaries.location.values,
      country: dictionaries.country.values,
      division: dictionaries.division.values.map(
        (id) => [id, divisionNames.get(id) ?? id] as const,
      ),
      city: dictionaries.city.values.map(
        (id) => cityRecords.get(id) ?? ([id, String(id), ""] as const),
      ),
      department: dictionaries.department.values,
      currency: dictionaries.currency.values,
    },
  };
}

/** The workplace a coded value stands for. */
export function workplaceOf(code: number): Workplace | null {
  return WORKPLACE_CODES[code] ?? null;
}

/** The employment types a bit set stands for. */
export function employmentOf(bits: number): EmploymentType[] {
  return EMPLOYMENT_CODES.filter((_, bit) => (bits & (1 << bit)) !== 0);
}

/**
 * Rejects a shard whose columns disagree: a length other than its row count, list counts that
 * don't add up, or a code outside its dictionary. The schema checks types; this checks that
 * the columns describe the same rows.
 */
function checkShard(shard: Shard): Shard {
  const { columns, dictionaries, rows } = shard;
  const problems: string[] = [];
  const scalars = {
    id: columns.id,
    title: columns.title,
    company: columns.company,
    workplace: columns.workplace,
    anywhere: columns.anywhere,
    inferred: columns.inferred,
    employment: columns.employment,
    department: columns.department,
    payMin: columns.payMin,
    payMax: columns.payMax,
    currency: columns.currency,
    posted: columns.posted,
  };
  for (const [name, values] of Object.entries(scalars)) {
    if (values.length !== rows) problems.push(`${name} has ${values.length} rows, not ${rows}`);
  }
  const within = (name: string, codes: readonly number[], size: number, optional: boolean) => {
    if (codes.some((code) => code >= size || code < (optional ? -1 : 0))) {
      problems.push(`${name} has a code outside its ${size} values`);
    }
  };
  within("company", columns.company, dictionaries.company.length, false);
  within("department", columns.department, dictionaries.department.length, true);
  within("currency", columns.currency, dictionaries.currency.length, true);
  within("workplace", columns.workplace, WORKPLACE_CODES.length, true);
  for (const name of LIST_NAMES) {
    const { counts, values } = columns[name];
    if (counts.length !== rows) problems.push(`${name} has ${counts.length} rows, not ${rows}`);
    const total = counts.reduce((sum, count) => sum + count, 0);
    if (values.length !== total) problems.push(`${name} has ${values.length} values, not ${total}`);
    within(name, values, dictionaries[name].length, false);
  }
  if (problems.length > 0) {
    throw new Error(`Shard ${shard.region}-${shard.part} is inconsistent: ${problems.join("; ")}`);
  }
  return shard;
}

const LIST_NAMES = ["location", "country", "division", "city"] as const;
type ListName = (typeof LIST_NAMES)[number];

/** Where each row's values start, per list column of a shard. */
function listOffsets(shard: Shard): Record<ListName, Int32Array> {
  const offsets = {} as Record<ListName, Int32Array>;
  for (const name of LIST_NAMES) {
    const { counts } = shard.columns[name];
    const starts = new Int32Array(counts.length);
    let total = 0;
    counts.forEach((count, row) => {
      starts[row] = total;
      total += count;
    });
    offsets[name] = starts;
  }
  return offsets;
}

function pick(offsets: Record<ListName, Int32Array>, row: number): Record<ListName, number> {
  return {
    location: offsets.location[row] ?? 0,
    country: offsets.country[row] ?? 0,
    division: offsets.division[row] ?? 0,
    city: offsets.city[row] ?? 0,
  };
}

function listBuilder() {
  const offsets: number[] = [0];
  const values: number[] = [];
  return {
    add(rowValues: readonly number[]) {
      values.push(...rowValues);
      offsets.push(values.length);
    },
    done(): ListColumn {
      return { offsets: Int32Array.from(offsets), values: Int32Array.from(values) };
    },
  };
}

function coder<T>() {
  const values: T[] = [];
  const codes = new Map<T, number>();
  return {
    values,
    code(value: T): number {
      let code = codes.get(value);
      if (code === undefined) {
        code = values.length;
        values.push(value);
        codes.set(value, code);
      }
      return code;
    },
  };
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The apply links of one shard, as a map from posting id to URL. `ids` is that shard's `id`
 * column, which the links file matches row for row; a file that doesn't match is refused,
 * since a silent misalignment would send people to the wrong job.
 */
export function readLinks(ids: readonly string[], linksJson: unknown): Map<string, string> {
  const links = parseLinks(linksJson);
  if (links.rows !== links.urls.length) {
    throw new Error(
      `${links.region}-${links.part} links: ${links.urls.length} urls, not ${links.rows}`,
    );
  }
  if (links.rows !== ids.length) {
    throw new Error(
      `${links.region}-${links.part} links: ${links.rows} rows, but the shard has ${ids.length}`,
    );
  }
  return new Map(ids.map((id, row) => [id, links.urls[row] ?? ""]));
}
