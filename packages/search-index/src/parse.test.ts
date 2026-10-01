import { describe, expect, it } from "vitest";
import { buildIndex, type IndexRow } from "./build.ts";
import { INDEX_FORMAT } from "./format.ts";
import { IndexFormatError, parseLinks, parseManifest, parseShard } from "./parse.ts";
import { linksSchema, manifestSchema, shardSchema } from "./schema.ts";

const DAY = 24 * 60 * 60 * 1000;
const BERLIN = { country: "DE", division: "16", city: 2950159 };

function row(id: string, overrides: Partial<IndexRow> = {}): IndexRow {
  return {
    id: `${id}${"0".repeat(Math.max(0, 16 - id.length))}`,
    title: "Engineer",
    company: "Acme",
    locations: ["Berlin"],
    places: [BERLIN],
    anywhere: false,
    inferred: false,
    workplace: "hybrid",
    employmentTypes: ["full-time"],
    department: "Engineering",
    pay: { min: 90_000, max: 120_000, currency: "EUR", statedPer: "year" },
    postedAt: 20_000 * DAY,
    url: `https://example.com/jobs/${id}`,
    ...overrides,
  };
}

const build = await buildIndex(
  [row("one"), row("two", { pay: null, postedAt: null, department: null, anywhere: true })],
  { builtAt: 20_001 * DAY, facetsVersion: 1 },
);
const file = (part: string) =>
  JSON.parse(build.files.find((f) => f.path.includes(part))?.content ?? "");
const manifest = JSON.parse(build.files[0]?.content ?? "");
const shard = file("/shards/");
const links = file("/links/");

describe("the readers' own checks", () => {
  it("read a real build, agreeing with the schemas the build is tested against", () => {
    expect(parseManifest(manifest)).toEqual(manifestSchema.parse(manifest));
    expect(parseShard(shard)).toEqual(shardSchema.parse(shard));
    expect(parseLinks(links)).toEqual(linksSchema.parse(links));
  });

  it.each([
    ["manifest", () => parseManifest({ ...manifest, format: INDEX_FORMAT + 1 }), /format 4/],
    ["manifest", () => parseManifest({ ...manifest, build: "nope" }), /manifest\.build/],
    ["manifest", () => parseManifest({ ...manifest, idLength: 4 }), /idLength/],
    ["manifest", () => parseManifest({ ...manifest, regions: {} }), /regions is not an array/],
    ["manifest", () => parseManifest(null), /manifest is not an object/],
    ["shard", () => parseShard({ ...shard, region: "mars" }), /names no region/],
    [
      "shard",
      () => parseShard({ ...shard, columns: { ...shard.columns, inferred: [0, 2] } }),
      /inferred\[1\] is not 0 or 1/,
    ],
    [
      "shard",
      () => parseShard({ ...shard, columns: { ...shard.columns, posted: ["today", null] } }),
      /posted\[0\] is not a number/,
    ],
    [
      "shard",
      () => parseShard({ ...shard, dictionaries: { ...shard.dictionaries, country: ["Germany"] } }),
      /country\[0\] is not in the expected form/,
    ],
    ["links", () => parseLinks({ ...links, urls: [1, 2] }), /urls\[0\] is not a string/],
  ])("refuse a %s that is not in the format", (_kind, read, message) => {
    expect(read).toThrow(IndexFormatError);
    expect(read).toThrow(message);
  });

  it("refuse a shard entry in the manifest without its links file", () => {
    const regions = manifest.regions.map((region: { shards: unknown[] }) => ({
      ...region,
      shards: region.shards.map((shard) => {
        const { links: _dropped, ...rest } = shard as Record<string, unknown>;
        return rest;
      }),
    }));
    expect(() => parseManifest({ ...manifest, regions })).toThrow(/links is not an object/);
  });
});
