import { describe, expect, it } from "vitest";
import {
  buildIndex,
  type IndexBuild,
  type IndexRow,
  regionsOf,
  shortestUniquePrefix,
} from "./build.ts";
import { manifestSchema, shardSchema } from "./schema.ts";

/** Shard files only; `build.files` also holds the manifest and the links files. */
const shardsOf = (build: IndexBuild) =>
  build.files.filter((file) => file.path.includes("/shards/"));

const DAY = 24 * 60 * 60 * 1000;
const BERLIN = { country: "DE", division: "16", city: 2950159 };
const SAN_FRANCISCO = { country: "US", division: "CA", city: 5391959 };

function row(id: string, overrides: Partial<IndexRow> = {}): IndexRow {
  return {
    id,
    title: `Engineer ${id}`,
    company: "Acme",
    locations: ["Berlin"],
    places: [BERLIN],
    anywhere: false,
    inferred: false,
    workplace: null,
    employmentTypes: ["full-time"],
    department: null,
    pay: null,
    postedAt: 20_000 * DAY,
    url: `https://example.com/jobs/${id}`,
    ...overrides,
  };
}

const options = { builtAt: Date.UTC(2026, 8, 28, 3, 30), facetsVersion: 1 };

describe("buildIndex", () => {
  it("writes a manifest and a shard per region, newest first, in the documented formats", async () => {
    const build = await buildIndex(
      [
        row("berlinold0000001", { postedAt: 20_001 * DAY }),
        row("berlinnew0000002", { postedAt: 20_003 * DAY }),
        row("sanfrancisco0003", { places: [SAN_FRANCISCO], locations: ["San Francisco, CA"] }),
      ],
      options,
    );
    const manifestFile = build.files[0];
    const shardFiles = shardsOf(build);
    expect(manifestFile?.path).toBe("manifest.json");
    const manifest = manifestSchema.parse(JSON.parse(manifestFile?.content ?? ""));
    expect(manifest).toEqual(build.manifest);
    expect(manifest).toMatchObject({
      postings: 3,
      idLength: 10,
      builtAt: "2026-09-28T03:30:00.000Z",
    });
    const regions = Object.fromEntries(manifest.regions.map((region) => [region.id, region.rows]));
    expect(regions).toMatchObject({ europe: 2, "north-america": 1, asia: 0, unplaced: 0 });
    expect(shardFiles.map((file) => file.path)).toEqual([
      `${manifest.build}/shards/north-america-0.json`,
      `${manifest.build}/shards/europe-0.json`,
    ]);
    const europe = shardSchema.parse(JSON.parse(shardFiles[1]?.content ?? ""));
    expect(europe.columns.id).toEqual(["berlinnew0", "berlinold0"]);
    expect(europe.columns.posted).toEqual([20_003, 20_001]);
    expect(europe.dictionaries.city).toEqual([[2950159, "Berlin", "DE"]]);
    expect(europe.dictionaries.division).toEqual([["DE.16", "State of Berlin"]]);
    expect(build.overBudget).toEqual([]);
  });

  it("names a build by its content", async () => {
    const rows = [row("aaaaaaaaaaaa1"), row("bbbbbbbbbbbb1")];
    const first = await buildIndex(rows, options);
    const again = await buildIndex([...rows].reverse(), { ...options, builtAt: 0 });
    const edited = await buildIndex(
      [row("aaaaaaaaaaaa1", { title: "Edited" }), rows[1] ?? row("x")],
      options,
    );
    expect(again.manifest.build).toBe(first.manifest.build);
    expect(edited.manifest.build).not.toBe(first.manifest.build);
  });

  it("splits a region into parts and reports what exceeds its budget", async () => {
    const rows = Array.from({ length: 5 }, (_, index) => row(`posting-${index}-${"x".repeat(8)}`));
    const build = await buildIndex(rows, {
      ...options,
      rowsPerPart: 2,
      budgets: { shardGzipBytes: 100, linksGzipBytes: 100, manifestBytes: 100, files: 3 },
    });
    const europe = build.manifest.regions.find((region) => region.id === "europe");
    expect(europe?.shards.map((shard) => shard.rows)).toEqual([2, 2, 1]);
    expect(build.overBudget).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/shards\/europe-0\.json is \d+ bytes gzipped \(budget 100\)/),
        expect.stringMatching(/links\/europe-0\.json is \d+ bytes gzipped \(budget 100\)/),
        expect.stringMatching(/^manifest\.json is \d+ bytes \(budget 100\)$/),
        "7 files (budget 3)",
      ]),
    );
  });
});

describe("regionsOf", () => {
  it("puts a posting in every continent it names, or in anywhere or unplaced", () => {
    expect(regionsOf({ places: [BERLIN, SAN_FRANCISCO], anywhere: false })).toEqual([
      "north-america",
      "europe",
    ]);
    expect(
      regionsOf({ places: [{ country: "AE", division: null, city: null }], anywhere: true }),
    ).toEqual(["asia", "anywhere"]);
    expect(regionsOf({ places: [], anywhere: true })).toEqual(["anywhere"]);
    expect(regionsOf({ places: [], anywhere: false })).toEqual(["unplaced"]);
  });
});

describe("shortestUniquePrefix", () => {
  it("uses ten characters unless prefixes that long would collide", () => {
    expect(shortestUniquePrefix(["abcdefghij12", "zbcdefghij12"])).toBe(10);
    expect(shortestUniquePrefix(["abcdefghij12", "abcdefghij34"])).toBe(11);
    expect(shortestUniquePrefix(["abcdefghijkl1", "abcdefghijkl2"])).toBe(13);
    expect(shortestUniquePrefix([])).toBe(10);
  });
});
