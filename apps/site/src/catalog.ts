import {
  type IndexTable,
  type Manifest,
  openIndex,
  parseManifest,
  REGIONS,
  readLinks,
} from "@quarry/search-index";

/**
 * Postings open to anywhere match every place, so that shard is always loaded. It is the
 * smallest one, a few kilobytes.
 */
const ALWAYS = "anywhere";

/**
 * Which continent to search before anyone chooses: the one the browser's own time zone names.
 * Nothing is sent anywhere to work this out. IANA zone names start with the continent, except
 * that the Americas share one and that the Pacific and Australia are both Oceania.
 */
const SOUTH_AMERICA = new Set([
  "America/Araguaina",
  "America/Argentina",
  "America/Asuncion",
  "America/Bahia",
  "America/Belem",
  "America/Boa_Vista",
  "America/Bogota",
  "America/Campo_Grande",
  "America/Caracas",
  "America/Cayenne",
  "America/Cuiaba",
  "America/Eirunepe",
  "America/Fortaleza",
  "America/Guayaquil",
  "America/Guyana",
  "America/La_Paz",
  "America/Lima",
  "America/Maceio",
  "America/Manaus",
  "America/Montevideo",
  "America/Noronha",
  "America/Paramaribo",
  "America/Porto_Velho",
  "America/Punta_Arenas",
  "America/Recife",
  "America/Rio_Branco",
  "America/Santarem",
  "America/Santiago",
  "America/Sao_Paulo",
]);

const BY_AREA: Readonly<Record<string, string>> = {
  Europe: "europe",
  Asia: "asia",
  Africa: "africa",
  Australia: "oceania",
  Pacific: "oceania",
  America: "north-america",
  Atlantic: "europe",
  Indian: "asia",
};

/** The region a time zone sits in, or Europe when it names none we know. */
export function regionOfZone(zone: string): string {
  const area = zone.split("/")[0] ?? "";
  if (area === "America") {
    const country = zone.split("/").slice(0, 2).join("/");
    return SOUTH_AMERICA.has(country) ? "south-america" : "north-america";
  }
  return BY_AREA[area] ?? "europe";
}

/** The region to search before anyone chooses, from the browser's time zone. */
export function defaultRegion(): string {
  try {
    return regionOfZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return "europe";
  }
}

export interface Catalog {
  readonly manifest: Manifest;
  /** The regions whose shards are loaded, so the table answers for them. */
  readonly regions: readonly string[];
  readonly table: IndexTable;
  /** Bytes downloaded for this table, as the manifest states them. */
  readonly bytes: number;
}

export interface RegionChoice {
  readonly id: string;
  readonly name: string;
  readonly rows: number;
}

/** Every region with postings, for the region picker. */
export function regionChoices(manifest: Manifest): RegionChoice[] {
  return REGIONS.map((region) => {
    const found = manifest.regions.find((entry) => entry.id === region.id);
    return { id: region.id, name: region.name, rows: found?.rows ?? 0 };
  }).filter((region) => region.rows > 0);
}

type Fetcher = (path: string) => Promise<unknown>;

/** Reads the manifest, which names the build and every file in it. */
export async function loadManifest(fetchJson: Fetcher): Promise<Manifest> {
  return parseManifest(await fetchJson("manifest.json"));
}

/**
 * Loads the shards for a region, plus the postings open to anywhere. The apply links are not
 * fetched here: `loadLinks` does that once results are on screen.
 */
export async function loadRegion(
  manifest: Manifest,
  region: string,
  fetchJson: Fetcher,
): Promise<{ catalog: Catalog; ids: Map<string, readonly string[]> }> {
  const wanted = new Set([region, ALWAYS]);
  const entries = manifest.regions
    .filter((entry) => wanted.has(entry.id))
    .flatMap((entry) => entry.shards);
  const shards = await Promise.all(entries.map(async (shard) => await fetchJson(shard.path)));
  const ids = new Map<string, readonly string[]>();
  for (const [index, shard] of shards.entries()) {
    const path = entries[index]?.links.path;
    const column = (shard as { columns?: { id?: readonly string[] } }).columns?.id;
    if (path !== undefined && column !== undefined) ids.set(path, column);
  }
  return {
    catalog: {
      manifest,
      regions: [...wanted],
      table: openIndex(manifest, shards),
      bytes: entries.reduce((total, shard) => total + shard.gzipBytes, 0),
    },
    ids,
  };
}

/**
 * Fetches the apply links for the loaded shards and pairs them with their postings. Searching
 * never needs these, so they are fetched after results are shown (ADR-0007).
 */
export async function loadLinks(
  ids: ReadonlyMap<string, readonly string[]>,
  fetchJson: Fetcher,
): Promise<Map<string, string>> {
  const links = new Map<string, string>();
  await Promise.all(
    [...ids].map(async ([path, column]) => {
      for (const [id, url] of readLinks(column, await fetchJson(path))) links.set(id, url);
    }),
  );
  return links;
}
