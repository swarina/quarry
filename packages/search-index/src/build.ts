import { sha256Hex, type Workplace } from "@quarry/domain";
import type { AnnualPay, EmploymentType } from "@quarry/facets";
import { gazetteer, type Place } from "@quarry/places";
import {
  BUDGETS,
  type Budgets,
  EMPLOYMENT_CODES,
  INDEX_FORMAT,
  type Links,
  MAX_SHARD_QUESTIONS,
  type Manifest,
  MIN_ID_LENGTH,
  REGIONS,
  type RegionId,
  ROWS_PER_PART,
  type Shard,
  type ShardQuestion,
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
  /** The only place is the company's home country, inferred rather than stated. */
  readonly inferred: boolean;
  readonly workplace: Workplace | null;
  readonly employmentTypes: readonly EmploymentType[];
  readonly department: string | null;
  readonly pay: AnnualPay | null;
  /** When the ATS says it was published, else when it was first seen, in epoch milliseconds. */
  readonly postedAt: number | null;
  /** Where to apply, which only opening a posting needs, so it is kept out of the shards. */
  readonly url: string;
  /**
   * The answers held for this posting, by question id: one probability per option, in
   * hundredths, in the order the question declares its options. A question with no answer is
   * absent rather than zeroed, so "unanswered" and "certainly not" stay different things.
   */
  readonly answers?: Readonly<Record<string, readonly number[]>>;
}

export interface IndexFile {
  /** Relative to the directory the manifest is in. */
  readonly path: string;
  readonly content: string;
}

export interface IndexBuild {
  readonly manifest: Manifest;
  /** "manifest.json", then every shard, then every links file. */
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
    /** Version of the rules that read stored answers; 0 when the build holds none. */
    readonly answersVersion?: number;
    /**
     * The questions whose answers the shards carry, in column order. A row's answer to a
     * question not named here is left out, so this list, not the rows, decides what a build
     * holds. Default: none, which builds an index with no answers in it.
     */
    readonly questions?: readonly ShardQuestion[];
    readonly rowsPerPart?: number;
    readonly budgets?: Budgets;
  },
): Promise<IndexBuild> {
  const rowsPerPart = options.rowsPerPart ?? ROWS_PER_PART;
  const budgets = options.budgets ?? BUDGETS;
  const questions = options.questions ?? [];
  const answersVersion = options.answersVersion ?? 0;
  if (questions.length > MAX_SHARD_QUESTIONS) {
    throw new Error(
      `${questions.length} questions exceeds the ${MAX_SHARD_QUESTIONS} a shard can carry, because "answered" is a bit per question`,
    );
  }
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

  const parts: {
    region: RegionId;
    part: number;
    rows: number;
    content: string;
    links: string;
  }[] = [];
  for (const region of REGIONS) {
    const members = byRegion.get(region.id) ?? [];
    for (let part = 0; part * rowsPerPart < members.length; part += 1) {
      const slice = members.slice(part * rowsPerPart, (part + 1) * rowsPerPart);
      parts.push({
        region: region.id,
        part,
        rows: slice.length,
        content: JSON.stringify(encodeShard(region.id, part, slice, idLength, questions)),
        links: JSON.stringify(encodeLinks(region.id, part, slice)),
      });
    }
  }
  const measured = await Promise.all(
    parts.map(async (shard) => ({
      ...shard,
      ...(await measure(shard.content)),
      linksFile: await measure(shard.links),
    })),
  );
  const build = (
    await sha256Hex(
      [
        INDEX_FORMAT,
        options.facetsVersion,
        answersVersion,
        idLength,
        // Named here as well as inside every shard, so rewording a question renames the build
        // even when no shard was written.
        questions.map((question) => `${question.id}@${question.version}`).join(","),
        ...measured.flatMap((shard) => [shard.sha256, shard.linksFile.sha256]),
      ].join("\n"),
    )
  ).slice(0, 12);
  const placed = measured.map((shard) => ({
    ...shard,
    path: `${build}/shards/${shard.region}-${shard.part}.json`,
    linksPath: `${build}/links/${shard.region}-${shard.part}.json`,
  }));

  const manifest: Manifest = {
    format: INDEX_FORMAT,
    build,
    builtAt: new Date(options.builtAt).toISOString(),
    facetsVersion: options.facetsVersion,
    answersVersion,
    postings: rows.length,
    idLength,
    regions: REGIONS.map((region) => ({
      id: region.id,
      name: region.name,
      rows: byRegion.get(region.id)?.length ?? 0,
      shards: placed
        .filter((shard) => shard.region === region.id)
        .map(({ path, rows: count, bytes, gzipBytes, sha256, linksPath, linksFile }) => ({
          path,
          rows: count,
          bytes,
          gzipBytes,
          sha256,
          links: { path: linksPath, rows: count, ...linksFile },
        })),
    })),
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const files: IndexFile[] = [
    { path: "manifest.json", content: manifestText },
    ...placed.map(({ path, content }) => ({ path, content })),
    ...placed.map(({ linksPath, links }) => ({ path: linksPath, content: links })),
  ];

  const overBudget = [
    ...placed
      .filter((shard) => shard.gzipBytes > budgets.shardGzipBytes)
      .map(
        (shard) =>
          `${shard.path} is ${shard.gzipBytes} bytes gzipped (budget ${budgets.shardGzipBytes})`,
      ),
    ...placed
      .filter((shard) => shard.linksFile.gzipBytes > budgets.linksGzipBytes)
      .map(
        (shard) =>
          `${shard.linksPath} is ${shard.linksFile.gzipBytes} bytes gzipped (budget ${budgets.linksGzipBytes})`,
      ),
  ];
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

function encodeLinks(region: RegionId, part: number, rows: readonly IndexRow[]): Links {
  return {
    format: INDEX_FORMAT,
    region,
    part,
    rows: rows.length,
    urls: rows.map((row) => row.url),
  };
}

function encodeShard(
  region: RegionId,
  part: number,
  rows: readonly IndexRow[],
  idLength: number,
  questions: readonly ShardQuestion[],
) {
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
    inferred: [] as (0 | 1)[],
    employment: [] as number[],
    department: [] as number[],
    payMin: [] as (number | null)[],
    payMax: [] as (number | null)[],
    currency: [] as number[],
    posted: [] as (number | null)[],
    // One flat run of probabilities per question, and a bit per question saying which rows hold
    // an answer. An unanswered row keeps its zeros, which gzip costs almost nothing for.
    answers: questions.map(() => [] as number[]),
    answered: [] as number[],
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
    columns.inferred.push(row.inferred ? 1 : 0);
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

    let answered = 0;
    questions.forEach((question, index) => {
      const column = columns.answers[index];
      if (column === undefined) return;
      const distribution = row.answers?.[question.id];
      // Only a distribution of the right width is kept: a stored answer whose options no longer
      // match the question's would otherwise line up against the wrong option.
      if (distribution !== undefined && distribution.length === question.options.length) {
        column.push(...distribution);
        answered |= 1 << index;
      } else {
        for (let option = 0; option < question.options.length; option += 1) column.push(0);
      }
    });
    columns.answered.push(answered);
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
    questions: [...questions],
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

/** A file's hash and its size before and after gzip, which is what a browser downloads. */
async function measure(
  content: string,
): Promise<{ sha256: string; bytes: number; gzipBytes: number }> {
  const stream = new Blob([content]).stream().pipeThrough(new CompressionStream("gzip"));
  return {
    sha256: await sha256Hex(content),
    bytes: new TextEncoder().encode(content).byteLength,
    gzipBytes: (await new Response(stream).arrayBuffer()).byteLength,
  };
}
