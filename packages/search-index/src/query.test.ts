import { describe, expect, it } from "vitest";
import { buildIndex, type IndexBuild, type IndexRow } from "./build.ts";
import { INDEX_FORMAT } from "./format.ts";
import { type IndexQuery, queryIndex } from "./query.ts";
import { type IndexTable, openIndex, readLinks } from "./table.ts";

/** Shard files only; `build.files` also holds the manifest and the links files. */
const shardsOf = (build: IndexBuild) =>
  build.files.filter((file) => file.path.includes("/shards/"));

const DAY = 24 * 60 * 60 * 1000;
const TODAY = 20_100;
const BERLIN = { country: "DE", division: "16", city: 2950159 };
const SAN_FRANCISCO = { country: "US", division: "CA", city: 5391959 };
const LONDON = { country: "GB", division: "ENG", city: 2643743 };

function row(id: string, overrides: Partial<IndexRow> = {}): IndexRow {
  return {
    id: `${id}${"0".repeat(16 - id.length)}`,
    title: "Engineer",
    company: "Acme",
    locations: ["Berlin"],
    places: [BERLIN],
    anywhere: false,
    inferred: false,
    workplace: "onsite",
    employmentTypes: ["full-time"],
    department: null,
    pay: null,
    postedAt: (TODAY - 1) * DAY,
    url: `https://example.com/jobs/${id}`,
    ...overrides,
  };
}

const ROWS: IndexRow[] = [
  row("berlin", {
    title: "Senior Backend Engineer",
    workplace: "hybrid",
    postedAt: (TODAY - 2) * DAY,
  }),
  row("zurich", {
    title: "Data Scientist, Zürich",
    company: "Beta",
    places: [{ country: "CH", division: "ZH", city: null }],
    locations: ["Zürich"],
    postedAt: (TODAY - 40) * DAY,
  }),
  row("sf", {
    title: "Staff Engineer",
    company: "Gamma",
    places: [SAN_FRANCISCO],
    locations: ["San Francisco, CA"],
    workplace: "onsite",
    pay: { min: 180_000, max: 220_000, currency: "USD", statedPer: "year" },
    department: "Engineering",
  }),
  row("both", {
    title: "Solutions Engineer",
    company: "Gamma",
    places: [SAN_FRANCISCO, BERLIN],
    locations: ["San Francisco, CA", "Berlin"],
    workplace: "remote",
    employmentTypes: ["full-time", "contract"],
    pay: { min: 150_000, max: null, currency: "USD", statedPer: "year" },
    postedAt: TODAY * DAY,
  }),
  row("london", {
    title: "Product Designer",
    company: "Delta",
    places: [LONDON],
    locations: ["London"],
    workplace: "remote",
    pay: { min: 70_000, max: 90_000, currency: "GBP", statedPer: "year" },
    employmentTypes: ["contract"],
  }),
  row("anywhere", {
    title: "Support Engineer",
    company: "Epsilon",
    places: [],
    locations: ["Worldwide"],
    anywhere: true,
    workplace: "remote",
    employmentTypes: [],
    postedAt: null,
  }),
  row("unplaced", { title: "Recruiter", company: "Zeta", places: [], locations: ["Hybrid"] }),
];

async function table(rows: readonly IndexRow[] = ROWS, regions?: readonly string[]) {
  const build = await buildIndex(rows, { builtAt: TODAY * DAY, facetsVersion: 1 });
  const manifest = build.files[0];
  const loaded = shardsOf(build).filter(
    (file) => regions === undefined || regions.some((region) => file.path.includes(`/${region}-`)),
  );
  return openIndex(
    JSON.parse(manifest?.content ?? ""),
    loaded.map((file) => JSON.parse(file.content)),
  );
}

const index = await table();
const ids = (result: ReturnType<typeof queryIndex>) =>
  result.rows.map((found) => found.id.replace(/0+$/, ""));
const run = (query: IndexQuery, from: IndexTable = index) =>
  queryIndex(from, { now: TODAY * DAY + 12 * 60 * 60 * 1000, ...query });

describe("openIndex", () => {
  it("has every posting once, newest first, whatever regions it is in", () => {
    expect(index.size).toBe(ROWS.length);
    // Newest first, ties by id; a posting without a date comes last.
    expect(ids(run({}))).toEqual([
      "both",
      "london",
      "sf",
      "unplaced",
      "berlin",
      "zurich",
      "anywhere",
    ]);
  });

  it("holds only the regions a reader loads", async () => {
    const europe = await table(ROWS, ["europe"]);
    expect(ids(run({}, europe)).sort()).toEqual(["berlin", "both", "london", "zurich"]);
  });

  it("refuses files in another format", async () => {
    const build = await buildIndex(ROWS, { builtAt: TODAY * DAY, facetsVersion: 1 });
    const manifest = JSON.parse(build.files[0]?.content ?? "");
    const shards = shardsOf(build).map((file) => JSON.parse(file.content));
    const format = (file: object, version: number) => ({ ...file, format: version });
    expect(() => openIndex(manifest, shards)).not.toThrow();
    expect(() => openIndex(format(manifest, INDEX_FORMAT + 1), shards)).toThrow();
    expect(() =>
      openIndex(
        manifest,
        shards.map((shard) => format(shard, INDEX_FORMAT - 1)),
      ),
    ).toThrow();
  });

  it("refuses a shard whose columns disagree", async () => {
    const build = await buildIndex(ROWS, { builtAt: TODAY * DAY, facetsVersion: 1 });
    const manifest = build.files[0];
    const shard = JSON.parse(shardsOf(build)[0]?.content ?? "");
    const broken = (change: (columns: Record<string, unknown>) => void) => {
      const copy = structuredClone(shard);
      change(copy.columns);
      return () => openIndex(JSON.parse(manifest?.content ?? ""), [copy]);
    };
    expect(broken((columns) => (columns["title"] as string[]).pop())).toThrow(
      /title has \d+ rows, not \d+/,
    );
    expect(broken((columns) => (columns["inferred"] as number[]).pop())).toThrow(
      /inferred has \d+ rows, not \d+/,
    );
    expect(broken((columns) => ((columns["company"] as number[])[0] = 99))).toThrow(
      /company has a code outside its \d+ values/,
    );
    expect(
      broken((columns) => (columns["country"] as { values: number[] }).values.push(0)),
    ).toThrow(/country has \d+ values, not \d+/);
  });
});

const linked = await buildIndex(ROWS, { builtAt: TODAY * DAY, facetsVersion: 1 });
const shard = JSON.parse(shardsOf(linked)[0]?.content ?? "");
const links = JSON.parse(linked.files.find((file) => file.path.includes("/links/"))?.content ?? "");

describe("readLinks", () => {
  it("maps each posting id to its apply link", () => {
    const found = readLinks(shard.columns.id, links);
    expect(found.size).toBe(shard.rows);
    for (const [index, id] of (shard.columns.id as string[]).entries()) {
      expect(found.get(id)).toBe(links.urls[index]);
    }
  });

  it("refuses a links file that does not line up with its shard", () => {
    expect(() => readLinks(shard.columns.id, { ...links, rows: links.rows + 1 })).toThrow(
      /urls, not/,
    );
    expect(() => readLinks([...shard.columns.id, "extra00000"], links)).toThrow(
      /but the shard has/,
    );
    expect(() => readLinks(shard.columns.id, { ...links, format: INDEX_FORMAT + 1 })).toThrow();
  });
});

describe("queryIndex", () => {
  it("returns rows as readers show them", () => {
    const [found] = run({ text: "staff" }).rows;
    expect(found).toEqual({
      id: "sf00000000",
      title: "Staff Engineer",
      company: "Gamma",
      locations: ["San Francisco, CA"],
      countries: ["US"],
      cities: ["San Francisco"],
      workplace: "onsite",
      anywhere: false,
      inferred: false,
      employmentTypes: ["full-time"],
      department: "Engineering",
      pay: { min: 180_000, max: 220_000, currency: "USD" },
      postedDay: TODAY - 1,
      // This fixture asks no questions, so a row carries no answers.
      answers: [],
    });
  });

  it("filters by place, with postings from anywhere unless asked not to", () => {
    expect(ids(run({ places: { countries: ["DE"] } }))).toEqual(["both", "berlin", "anywhere"]);
    expect(ids(run({ places: { countries: ["DE"] }, includeAnywhere: false }))).toEqual([
      "both",
      "berlin",
    ]);
    expect(ids(run({ places: { divisions: ["US.CA"] }, includeAnywhere: false }))).toEqual([
      "both",
      "sf",
    ]);
    expect(ids(run({ places: { cities: [2643743] }, includeAnywhere: false }))).toEqual(["london"]);
    expect(run({ places: { countries: ["JP"] }, includeAnywhere: false }).total).toBe(0);
  });

  it("filters by arrangement, employment type, and company", () => {
    expect(ids(run({ workplaces: ["remote"] }))).toEqual(["both", "london", "anywhere"]);
    expect(ids(run({ employment: ["contract"] }))).toEqual(["both", "london"]);
    expect(ids(run({ companies: ["Gamma"] }))).toEqual(["both", "sf"]);
  });

  it("filters by how recently a posting was published", () => {
    expect(ids(run({ postedWithinDays: 1 }))).toEqual(["both", "london", "sf", "unplaced"]);
    expect(run({ postedWithinDays: 30 }).total).toBe(5);
  });

  it("filters by the pay a posting reaches in a currency", () => {
    expect(ids(run({ minimumPay: { amount: 200_000, currency: "USD" } }))).toEqual(["sf"]);
    expect(ids(run({ minimumPay: { amount: 150_000, currency: "USD" } }))).toEqual(["both", "sf"]);
    expect(run({ minimumPay: { amount: 1, currency: "JPY" } }).total).toBe(0);
  });

  it("matches every word of the text in the title or company, ignoring accents", () => {
    expect(ids(run({ text: "engineer gamma" }))).toEqual(["both", "sf"]);
    expect(ids(run({ text: "zurich" }))).toEqual(["zurich"]);
    expect(ids(run({ text: "  ENGINEER  " }))).toHaveLength(4);
  });

  it("counts each facet over the postings every other filter lets through", () => {
    const result = run({
      places: { countries: ["DE"] },
      workplaces: ["remote"],
      includeAnywhere: false,
    });
    expect(ids(result)).toEqual(["both"]);
    // Countries of remote postings; arrangements of German postings.
    expect(result.facets.countries).toEqual([
      ["DE", 1],
      ["GB", 1],
      ["US", 1],
    ]);
    expect(result.facets.workplaces).toEqual([
      ["hybrid", 1],
      ["remote", 1],
    ]);
    expect(result.facets.employment).toEqual([
      ["contract", 1],
      ["full-time", 1],
    ]);
    expect(result.facets.companies).toEqual([["Gamma", 1]]);
  });

  it("counts a country facet as what choosing it would show, postings from anywhere included", () => {
    // The promise a facet count makes is "this many if you pick me", so a posting open to
    // anywhere, which matches every country, has to be in every country's count.
    const counted = Object.fromEntries(run({}).facets.countries);
    for (const [country, count] of Object.entries(counted)) {
      expect(run({ places: { countries: [country] } }).total).toBe(count);
    }
    // Without them, the counts are of the postings that name each country.
    const named = Object.fromEntries(run({ includeAnywhere: false }).facets.countries);
    for (const [country, count] of Object.entries(named)) {
      expect(run({ places: { countries: [country] }, includeAnywhere: false }).total).toBe(count);
    }
    // The fixture has one posting open to anywhere, and it names no country of its own.
    expect(counted["DE"]).toBe((named["DE"] ?? 0) + 1);
  });

  it("sorts by pay in a currency, then newest, and pages", () => {
    const byPay = run({ sort: { pay: "USD" } });
    expect(ids(byPay).slice(0, 3)).toEqual(["sf", "both", "london"]);
    expect(ids(run({ sort: { pay: "USD" }, offset: 1, limit: 2 }))).toEqual(["both", "london"]);
    expect(run({ limit: 2 }).total).toBe(ROWS.length);
  });

  it("counts the matching postings by the currency they state pay in", () => {
    // The fixture prices two postings in dollars and one in pounds; the rest state no pay.
    expect(run({}).pay.currencies).toEqual([
      ["USD", 2],
      ["GBP", 1],
    ]);
    // Over the postings the filters left, like the answered count and unlike a facet count.
    expect(run({ places: { countries: ["GB"] }, includeAnywhere: false }).pay.currencies).toEqual([
      ["GBP", 1],
    ]);
    expect(run({ text: "recruiter" }).pay.currencies).toEqual([]);
  });

  it("ranks within the currency most of the matching postings state, when told none", () => {
    // Naming a currency the caller did not choose is the defect this replaced: a pay sort that
    // assumed one left every posting priced in another in the tail with the unpriced ones.
    const auto = run({ sort: { pay: null } });
    expect(auto.pay.within).toBe("USD");
    expect(ids(auto).slice(0, 2)).toEqual(["sf", "both"]);
    // A search of the pound postings ranks in pounds, with no filter saying so.
    const british = run({ sort: { pay: null }, places: { countries: ["GB"] } });
    expect(british.pay.within).toBe("GBP");
    expect(ids(british)[0]).toBe("london");
  });

  it("reports the currency it ranked within, and none when it could not rank", () => {
    expect(run({}).pay.within).toBeNull();
    expect(run({ sort: { pay: "GBP" } }).pay.within).toBe("GBP");
    // Nothing states pay, so there is nothing to rank by and the rows are in date order.
    const unpriced = run({ sort: { pay: null }, text: "recruiter" });
    expect(unpriced.pay.within).toBeNull();
    expect(ids(unpriced)).toEqual(["unplaced"]);
    // A currency nothing is priced in ranks nothing, and says which currency that was.
    const absent = run({ sort: { pay: "JPY" } });
    expect(absent.pay.within).toBe("JPY");
    expect(ids(absent)).toEqual(ids(run({})));
  });
});
