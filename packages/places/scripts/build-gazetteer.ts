/**
 * Builds `data/gazetteer.json` from GeoNames (https://www.geonames.org), licensed under CC BY
 * 4.0: every country (`countryInfo.txt`), every first-level division (`admin1CodesASCII.txt`),
 * every city with more than 15,000 people or that is a capital (`cities15000.zip`), and the few
 * smaller places in `EXTRA_CITIES` (from the per-country dumps). Only
 * what reading location labels needs is kept. Non-ASCII characters are written as JSON `\u`
 * escapes, so the file is plain ASCII yet decodes to the original names.
 *
 * Usage: pnpm --filter @quarry/places build-gazetteer [--cache <dir>]
 * With `--cache`, downloaded files are kept there and reused on the next run.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { crc32, inflateRawSync } from "node:zlib";

const BASE_URL = "https://download.geonames.org/export/dump/";
const USER_AGENT = "QuarryBot/0.1 (+https://github.com/swarina/quarry)";
const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const OUTPUT = join(PACKAGE_DIR, "data", "gazetteer.json");

/** Alternate names longer than this are descriptions rather than names people write. */
const MAX_NAME_LENGTH = 40;
/**
 * A capitalized name in Latin letters (with any accents), spaces, and the punctuation place
 * names use. Lowercase entries are romanizations of other scripts ("baeng-geollo").
 */
const WRITABLE_NAME = /^\p{Lu}[\p{Script=Latin}\p{M} .'\u2019-]*$/u;
/** All capitals: airport and other codes ("MUC", "BLR"), which the parser curates instead. */
const CODE = /^[\p{Lu} .-]+$/u;

const { values } = parseArgs({ options: { cache: { type: "string" } }, strict: true });

async function download(name: string): Promise<Buffer> {
  const cached = values.cache === undefined ? undefined : join(values.cache, name);
  if (cached !== undefined) {
    try {
      return await readFile(cached);
    } catch {
      // Not cached yet.
    }
  }
  const response = await fetch(`${BASE_URL}${name}`, { headers: { "user-agent": USER_AGENT } });
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  const body = Buffer.from(await response.arrayBuffer());
  if (cached !== undefined) {
    await mkdir(dirname(cached), { recursive: true });
    await writeFile(cached, body);
  }
  return body;
}

/** The one file inside a zip archive, found through the central directory and CRC-checked. */
function unzipSingle(archive: Buffer, name: string): Buffer {
  const END = 0x06054b50;
  let end = archive.length - 22;
  while (end >= 0 && archive.readUInt32LE(end) !== END) end -= 1;
  if (end < 0) throw new Error("Not a zip archive");
  let entry = archive.readUInt32LE(end + 16);
  const entries = archive.readUInt16LE(end + 10);
  for (let index = 0; index < entries; index += 1) {
    if (archive.readUInt32LE(entry) !== 0x02014b50) throw new Error("Corrupt central directory");
    const method = archive.readUInt16LE(entry + 10);
    const crc = archive.readUInt32LE(entry + 16);
    const compressedSize = archive.readUInt32LE(entry + 20);
    const nameLength = archive.readUInt16LE(entry + 28);
    const extraLength = archive.readUInt16LE(entry + 30);
    const commentLength = archive.readUInt16LE(entry + 32);
    const localHeader = archive.readUInt32LE(entry + 42);
    const entryName = archive.toString("utf8", entry + 46, entry + 46 + nameLength);
    if (entryName === name) {
      if (archive.readUInt32LE(localHeader) !== 0x04034b50) throw new Error("Corrupt local header");
      const start =
        localHeader +
        30 +
        archive.readUInt16LE(localHeader + 26) +
        archive.readUInt16LE(localHeader + 28);
      const data = archive.subarray(start, start + compressedSize);
      const content = method === 8 ? inflateRawSync(data) : method === 0 ? data : undefined;
      if (content === undefined) throw new Error(`${name}: unsupported compression ${method}`);
      if (crc32(content) !== crc) throw new Error(`${name}: CRC mismatch`);
      return content;
    }
    entry += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`${name} is not in the archive`);
}

function rows(text: string): string[][] {
  return text
    .split("\n")
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => line.split("\t"));
}

function fold(name: string): string {
  return name.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Names that belong to a country or division, and which cities may still use them. */
interface Reserved {
  /** Folded country names and codes, to the country they name. */
  readonly countries: ReadonlyMap<string, string>;
  /** Folded division names, to the divisions ("US.NY") they name. */
  readonly divisions: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * Alternate names worth matching: capitalized, in Latin script, not a code, and distinct once
 * folded. A name that belongs to a country is kept only for that country's capital ("Mexico"
 * for Mexico City), and one that belongs to a division only for a city in it ("New York" for
 * New York City). GeoNames lists "USA" for a town called Concord and "India" for Inđija; as
 * city names those would only ever be wrong.
 */
function alternates(
  city: { readonly main: string; readonly ascii: string; readonly list: string },
  where: { readonly country: string; readonly division: string; readonly capital: boolean },
  reserved: Reserved,
): string[] {
  const seen = new Set([fold(city.main), fold(city.ascii)]);
  const kept: string[] = [];
  for (const raw of city.list.split(",")) {
    const name = raw.trim();
    const folded = fold(name);
    if (name.length < 2 || name.length > MAX_NAME_LENGTH || seen.has(folded)) continue;
    if (!WRITABLE_NAME.test(name) || CODE.test(name)) continue;
    const country = reserved.countries.get(folded);
    if (country !== undefined && !(where.capital && country === where.country)) continue;
    const divisions = reserved.divisions.get(folded);
    if (divisions !== undefined && !divisions.has(`${where.country}.${where.division}`)) continue;
    seen.add(folded);
    kept.push(name);
  }
  return kept.sort();
}

/**
 * Places too small for `cities15000.zip` that job postings name, by GeoNames id, under the
 * country whose dump holds them. Kept short on purpose: small places collide with common words
 * and names far more often than cities do, so each one needs postings that name it.
 */
const EXTRA_CITIES: ReadonlyMap<string, readonly number[]> = new Map([
  // King Abdullah Economic City, where Lucid Motors builds cars.
  ["SA", [11524299]],
]);

const [countryInfo, admin1Codes, citiesZip, ...countryZips] = await Promise.all([
  download("countryInfo.txt"),
  download("admin1CodesASCII.txt"),
  download("cities15000.zip"),
  ...[...EXTRA_CITIES.keys()].map((country) => download(`${country}.zip`)),
]);

/** Codes ISO 3166-1 has withdrawn but GeoNames still lists: Netherlands Antilles, Serbia and Montenegro. */
const WITHDRAWN = new Set(["AN", "CS"]);

// ISO, ISO3, name, continent, population.
const countries = rows(countryInfo.toString("utf8"))
  .map((row) => [row[0], row[1], row[4], row[8], Number(row[7])] as const)
  .filter(([code]) => code !== undefined && /^[A-Z]{2}$/.test(code) && !WITHDRAWN.has(code))
  .sort((left, right) => String(left[0]).localeCompare(String(right[0])));
const countryCodes = new Set(countries.map(([code]) => code));

// Country, division code, name.
const admin1 = rows(admin1Codes.toString("utf8"))
  .flatMap((row) => {
    const [country, code] = (row[0] ?? "").split(".");
    return country !== undefined && code !== undefined && countryCodes.has(country)
      ? [[country, code, row[1] ?? ""] as const]
      : [];
  })
  .sort((left, right) => `${left[0]}.${left[1]}`.localeCompare(`${right[0]}.${right[1]}`));

const reserved: Reserved = {
  countries: new Map(
    countries.flatMap(([code, iso3, name]) =>
      [code, iso3, name].map((value) => [fold(value ?? ""), code ?? ""] as const),
    ),
  ),
  divisions: admin1.reduce((names, [country, code, name]) => {
    const folded = fold(name);
    names.set(folded, new Set([...(names.get(folded) ?? []), `${country}.${code}`]));
    return names;
  }, new Map<string, Set<string>>()),
};

const divisionIds = new Set(admin1.map(([country, code]) => `${country}.${code}`));

const cityRows = rows(unzipSingle(citiesZip, "cities15000.txt").toString("utf8"));
const listed = new Set(cityRows.map((row) => row[0]));
const extraRows = [...EXTRA_CITIES].flatMap(([country, ids], index) => {
  const archive = countryZips[index];
  if (archive === undefined) throw new Error(`${country}.zip was not downloaded`);
  const found = rows(unzipSingle(archive, `${country}.txt`).toString("utf8")).filter((row) =>
    ids.includes(Number(row[0])),
  );
  const missing = ids.filter((id) => !found.some((row) => Number(row[0]) === id));
  if (missing.length > 0) throw new Error(`${country}.zip has no place ${missing.join(", ")}`);
  return found.filter((row) => !listed.has(row[0]));
});

// GeoNames id, name, country, division code, population, alternate names. A division code
// GeoNames doesn't define (such as "00") becomes empty.
const cities = [...cityRows, ...extraRows]
  .flatMap((row) => {
    const [id, name, ascii, alternateNames] = row;
    const country = row[8];
    if (id === undefined || name === undefined || country === undefined) return [];
    if (!countryCodes.has(country)) return [];
    const division = divisionIds.has(`${country}.${row[10]}`) ? (row[10] ?? "") : "";
    return [
      [
        Number(id),
        name,
        country,
        division,
        Number(row[14] ?? 0),
        alternates(
          { main: name, ascii: ascii ?? name, list: alternateNames ?? "" },
          { country, division, capital: row[7] === "PPLC" },
          reserved,
        ),
      ] as const,
    ];
  })
  .sort((left, right) => left[0] - right[0]);

const gazetteer = {
  source: "GeoNames (https://www.geonames.org), licensed under CC BY 4.0",
  retrieved: new Date().toISOString().slice(0, 10),
  countries,
  admin1,
  cities,
};

// One record per line keeps diffs readable when the data is refreshed.
const json = [
  "{",
  `  "source": ${JSON.stringify(gazetteer.source)},`,
  `  "retrieved": ${JSON.stringify(gazetteer.retrieved)},`,
  ...(["countries", "admin1", "cities"] as const).flatMap((key, index, keys) => [
    `  ${JSON.stringify(key)}: [`,
    gazetteer[key].map((record) => `    ${JSON.stringify(record)}`).join(",\n"),
    `  ]${index < keys.length - 1 ? "," : ""}`,
  ]),
  "}",
  "",
].join("\n");
const ascii = json.replace(
  /[^\x20-\x7e\n]/g,
  (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
);
await writeFile(OUTPUT, ascii);
console.log(
  `Wrote ${countries.length} countries, ${admin1.length} divisions, and ${cities.length} cities to ${OUTPUT} (${(ascii.length / 1024).toFixed(0)} KB).`,
);
