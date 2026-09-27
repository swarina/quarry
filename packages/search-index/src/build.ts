import { sha256Hex, type Workplace } from "@quarry/domain";
import type { AnnualPay, EmploymentType } from "@quarry/facets";
import { gazetteer, type Place } from "@quarry/places";
import {
  BUDGETS,
  type Budgets,
  EMPLOYMENT_CODES,
  INDEX_FORMAT,
  type Manifest,
  MIN_ID_LENGTH,
  REGIONS,
  type RegionId,
  ROWS_PER_PART,
  type Shard,
  WORKPLACE_CODES,
} from "./format.ts";

/** One posting, as the builder takes it. */
export interface IndexRow {
  /** The full posting id. */
  readonly id: string;
  readonly title: string;
  readonly company: string;
  /** Location labels as stated, for display. */
  readonly locations: readonly string[];
  readonly places: readonly Place[];
  readonly anywhere: boolean;
  readonly workplace: Workplace | null;
  readonly employmentTypes: readonly EmploymentType[];
  readonly department: string | null;
  readonly pay: AnnualPay | null;
  /** When the ATS says it was published, else when it was first seen, in epoch milliseconds. */
  readonly postedAt: number | null;
}

export interface IndexFile {
  /** Relative to the directory the manifest is in. */
  readonly path: string;
  readonly content: string;
}

export interface IndexBuild {
  readonly manifest: Manifest;
  /** "manifest.json", then every shard. */
  readonly files: readonly IndexFile[];
  /** The budgets the build exceeds; empty when it fits. */
  readonly overBudget: readonly string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Builds the static index (ADR-0007): the rows split into region shards, newest first, each a
 * self-contained columnar JSON file, and a manifest naming them. The build is named by a hash
 * of its shards and the facet rules, so an unchanged corpus gives the same build.
 */
export async function buildIndex(
  rows: readonly IndexRow[],
  options: {
    readonly builtAt: number;
    readonly facetsVersion: number;
    readonly rowsPerPart?: number;
    readonly budgets?: Budgets;
  },
): Promise<IndexBuild> {
  const rowsPerPart = options.rowsPerPart ?? ROWS_PER_PART;
  const budgets = options.budgets ?? BUDGETS;
  const idLength = shortestUniquePrefix(rows.map((row) => row.id));
  const sorted = [...rows].sort(
    (left, right) =>
      (right.postedAt ?? Number.NEGATIVE_INFINITY) - (left.postedAt ?? Number.NEGATIVE_INFINITY) ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  );
  const byRegion = new Map<RegionId, IndexRow[]>(REGIONS.map((region) => [region.id, []]));
  for (const row of sorted) {
    for (const region of regionsOf(row)) byRegion.get(region)?.push(row);
  }

  const parts: { region: RegionId; part: number; rows: number; content: string }[] = [];
  for (const region of REGIONS) {
    const members = byRegion.get(region.id) ?? [];
    for (let part = 0; part * rowsPerPart < members.length; part += 1) {
      const slice = members.slice(part * rowsPerPart, (part + 1) * rowsPerPart);
      const content = JSON.stringify(encodeShard(region.id, part, slice, idLength));
      parts.push({ region: region.id, part, rows: slice.length, content });
    }
  }
  const measured = await Promise.all(
    parts.map(async (shard) => ({
      ...shard,
      sha256: await sha256Hex(shard.content),
      bytes: new TextEncoder().encode(shard.content).byteLength,
      gzipBytes: await gzipSize(shard.content),
    })),
  );
  const build = (
    await sha256Hex(
      [
        INDEX_FORMAT,
        options.facetsVersion,
        idLength,
        ...measured.map((shard) => shard.sha256),
      ].join("\n"),
    )
  ).slice(0, 12);
  const placed = measured.map((shard) => ({
    ...shard,
    path: `${build}/shards/${shard.region}-${shard.part}.json`,
  }));

  const manifest: Manifest = {
    format: INDEX_FORMAT,
    build,
    builtAt: new Date(options.builtAt).toISOString(),
    facetsVersion: options.facetsVersion,
    postings: rows.length,
    idLength,
    regions: REGIONS.map((region) => ({
      id: region.id,
      name: region.name,
      rows: byRegion.get(region.id)?.length ?? 0,
      shards: placed
        .filter((shard) => shard.region === region.id)
        .map(({ path, rows: count, bytes, gzipBytes, sha256 }) => ({
          path,
          rows: count,
          bytes,
          gzipBytes,
          sha256,
        })),
    })),
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const files: IndexFile[] = [
    { path: "manifest.json", content: manifestText },
    ...placed.map(({ path, content }) => ({ path, content })),
  ];

  const overBudget = placed
    .filter((shard) => shard.gzipBytes > budgets.shardGzipBytes)
    .map(
      (shard) =>
        `${shard.path} is ${shard.gzipBytes} bytes gzipped (budget ${budgets.shardGzipBytes})`,
    );
  const manifestBytes = new TextEncoder().encode(manifestText).byteLength;
  if (manifestBytes > budgets.manifestBytes) {
    overBudget.push(`manifest.json is ${manifestBytes} bytes (budget ${budgets.manifestBytes})`);
  }
  if (files.length > budgets.files)
    overBudget.push(`${files.length} files (budget ${budgets.files})`);
  return { manifest, files, overBudget };
}

/** The regions a posting's shards are in: its places' continents, anywhere, or unplaced. */
export function regionsOf(row: Pick<IndexRow, "places" | "anywhere">): RegionId[] {
  const continents = continentsByCountry();
  const regions = new Set<RegionId>();
  for (const place of row.places) {
    const continent = continents.get(place.country);
    const region = REGIONS.find((candidate) => candidate.continent === continent);
    if (region !== undefined) regions.add(region.id);
  }
  if (row.anywhere) regions.add("anywhere");
  if (regions.size === 0) regions.add("unplaced");
  return REGIONS.filter((region) => regions.has(region.id)).map((region) => region.id);
}

/** The shortest prefix length, at least MIN_ID_LENGTH, that keeps every id distinct. */
export function shortestUniquePrefix(ids: readonly string[]): number {
  const longest = ids.reduce((length, id) => Math.max(length, id.length), MIN_ID_LENGTH);
  for (let length = MIN_ID_LENGTH; length < longest; length += 1) {
    if (new Set(ids.map((id) => id.slice(0, length))).size === new Set(ids).size) return length;
  }
  return longest;
}

function encodeShard(region: RegionId, part: number, rows: readonly IndexRow[], idLength: number) {
  const { cities, divisions } = gazetteer();
  const dictionaries = {
    company: dictionary<string>(),
    location: dictionary<string>(),
    country: dictionary<string>(),
    division: dictionary<string>(),
    city: dictionary<number>(),
    department: dictionary<string>(),
    currency: dictionary<string>(),
  };
  const list = () => ({ counts: [] as number[], values: [] as number[] });
  const columns = {
    id: [] as string[],
    title: [] as string[],
    company: [] as number[],
    location: list(),
    country: list(),
    division: list(),
    city: list(),
    workplace: [] as number[],
    anywhere: [] as (0 | 1)[],
    employment: [] as number[],
    department: [] as number[],
    payMin: [] as (number | null)[],
    payMax: [] as (number | null)[],
    currency: [] as number[],
    posted: [] as (number | null)[],
  };
  const push = <T>(
    column: { counts: number[]; values: number[] },
    values: readonly T[],
    codeOf: (value: T) => number,
  ) => {
    const unique = [...new Set(values)];
    column.counts.push(unique.length);
    for (const value of unique) column.values.push(codeOf(value));
  };

  for (const row of rows) {
    columns.id.push(row.id.slice(0, idLength));
    columns.title.push(row.title);
    columns.company.push(dictionaries.company.code(row.company));
    push(columns.location, row.locations, (label) => dictionaries.location.code(label));
    push(
      columns.country,
      row.places.map((place) => place.country),
      (code) => dictionaries.country.code(code),
    );
    push(
      columns.division,
      row.places.flatMap((place) =>
        place.division === null ? [] : [`${place.country}.${place.division}`],
      ),
      (id) => dictionaries.division.code(id),
    );
    push(
      columns.city,
      row.places.flatMap((place) => (place.city === null ? [] : [place.city])),
      (id) => dictionaries.city.code(id),
    );
    columns.workplace.push(row.workplace === null ? -1 : WORKPLACE_CODES.indexOf(row.workplace));
    columns.anywhere.push(row.anywhere ? 1 : 0);
    columns.employment.push(
      row.employmentTypes.reduce((bits, type) => bits | (1 << EMPLOYMENT_CODES.indexOf(type)), 0),
    );
    columns.department.push(
      row.department === null ? -1 : dictionaries.department.code(row.department),
    );
    columns.payMin.push(row.pay?.min ?? null);
    columns.payMax.push(row.pay?.max ?? null);
    columns.currency.push(row.pay === null ? -1 : dictionaries.currency.code(row.pay.currency));
    columns.posted.push(row.postedAt === null ? null : Math.floor(row.postedAt / DAY_MS));
  }

  const divisionNames = new Map(
    divisions.map((division) => [`${division.country}.${division.code}`, division.name]),
  );
  const cityRecords = new Map(cities.map((city) => [city.id, city]));
  const shard: Shard = {
    format: INDEX_FORMAT,
    region,
    part,
    rows: rows.length,
    dictionaries: {
      company: dictionaries.company.values,
      location: dictionaries.location.values,
      country: dictionaries.country.values,
      division: dictionaries.division.values.map((id) => [id, divisionNames.get(id) ?? id]),
      city: dictionaries.city.values.map((id) => {
        const city = cityRecords.get(id);
        return [id, city?.name ?? String(id), city?.country ?? ""];
      }),
      department: dictionaries.department.values,
      currency: dictionaries.currency.values,
    },
    columns,
  };
  return shard;
}

function dictionary<T>() {
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

let continents: ReadonlyMap<string, string> | undefined;

function continentsByCountry(): ReadonlyMap<string, string> {
  continents ??= new Map(gazetteer().countries.map((country) => [country.code, country.continent]));
  return continents;
}

/** Bytes after gzip at its default level, which is what a browser downloads at most. */
async function gzipSize(text: string): Promise<number> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return (await new Response(stream).arrayBuffer()).byteLength;
}
