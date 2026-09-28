import { boardId, type NormalizedPosting, postingContentHash, postingId } from "@quarry/domain";
import { openIndex, queryIndex } from "@quarry/search-index";
import { openPipelineStore, type PipelineStore, type SeedBoard } from "@quarry/storage/node";
import { beforeEach, describe, expect, it } from "vitest";
import { buildSearchIndex, renderSearchIndexSummary, type SearchIndexReport } from "./search.ts";

const T0 = Date.UTC(2026, 8, 28, 3, 17);
const DAY = 24 * 60 * 60 * 1000;
const ACME: SeedBoard = { source: "greenhouse", slug: "acme", company: "Acme", country: "US" };
const ACME_ID = boardId("greenhouse", "acme");

let store: PipelineStore;

function posting(
  externalId: string,
  overrides: Partial<NormalizedPosting> = {},
): NormalizedPosting {
  return {
    externalId,
    title: `Engineer ${externalId}`,
    url: `https://example.com/jobs/${externalId}`,
    applyUrl: null,
    locations: ["San Francisco, CA"],
    places: [],
    country: null,
    workplace: null,
    employmentType: null,
    department: null,
    team: null,
    language: null,
    publishedAt: T0 - 3 * DAY,
    salary: null,
    descriptionHtml: "<p>Role</p>",
    ...overrides,
  };
}

async function list(postings: NormalizedPosting[]) {
  store.startRun({ id: "run-1", trigger: "local", codeVersion: "test", startedAt: T0 });
  const items = await Promise.all(
    postings.map(async (value) => ({
      kind: "posting" as const,
      postingId: await postingId(ACME_ID, value.externalId),
      externalId: value.externalId,
      posting: value,
      contentHash: await postingContentHash(value),
      rawJson: "{}",
    })),
  );
  const board = store.board(ACME_ID);
  if (board === undefined) throw new Error("board missing");
  store.recordListing(
    board,
    { runId: "run-1", startedAt: T0, finishedAt: T0, attempts: 1, bytes: 0, httpStatus: 200 },
    { items, etag: null, normalizerVersion: 2 },
  );
}

beforeEach(() => {
  store = openPipelineStore(":memory:");
  store.syncBoards([ACME], [], T0);
});

describe("buildSearchIndex", () => {
  it("indexes the postings boards list now, with their structured facets", async () => {
    await list([
      posting("1", { employmentType: "Full-time" }),
      posting("2", {
        locations: ["Hybrid"],
        places: [{ label: null, text: "Berlin, Germany" }],
        publishedAt: null,
      }),
      posting("3", { locations: ["Home based - Worldwide"] }),
      posting("4", { locations: ["Jobs.cz"] }),
      posting("5", { title: "EXTERNAL TEMPLATE - Hybrid adverts" }),
      // Hybrid, and nothing else says where: placed in the company's home country, inferred.
      posting("6", { locations: ["Hybrid"] }),
    ]);
    const { build, report } = await buildSearchIndex(store, T0);
    expect(report).toMatchObject({
      postings: 5,
      placeholders: 1,
      byBasis: { labels: 1, structured: 1, home: 1, none: 2 },
      withCity: 2,
      anywhere: 1,
      unplacedLabels: [["Jobs.cz", 1]],
      overBudget: [],
    });

    const [manifest, ...shards] = build.files;
    const table = openIndex(
      JSON.parse(manifest?.content ?? ""),
      shards.map((file) => JSON.parse(file.content)),
    );
    const germany = queryIndex(table, { places: { countries: ["DE"] }, includeAnywhere: false });
    // Placed by its office, and dated by when it was first seen.
    expect(germany.rows).toEqual([
      expect.objectContaining({
        title: "Engineer 2",
        workplace: "hybrid",
        countries: ["DE"],
        postedDay: Math.floor(T0 / DAY),
      }),
    ]);
    expect(queryIndex(table, { employment: ["full-time"] }).rows).toEqual([
      expect.objectContaining({ title: "Engineer 1", cities: ["San Francisco"] }),
    ]);
    const unitedStates = queryIndex(table, {
      places: { countries: ["US"] },
      includeAnywhere: false,
    });
    expect(unitedStates.rows.map((row) => [row.title, row.inferred, row.cities]).sort()).toEqual([
      ["Engineer 1", false, ["San Francisco"]],
      ["Engineer 6", true, []],
    ]);
  });
});

describe("renderSearchIndexSummary", () => {
  const report: SearchIndexReport = {
    build: "1b3543dd7069",
    postings: 1_000,
    placeholders: 0,
    byBasis: { labels: 950, structured: 35, home: 5, none: 10 },
    withCity: 800,
    anywhere: 12,
    unplacedLabels: [
      ["Jobs.cz", 5],
      ["Office | Field", 2],
    ],
    shards: [
      { path: "1b3543dd7069/shards/europe-0.json", rows: 600, gzipBytes: 120 * 1024 },
      { path: "1b3543dd7069/shards/asia-0.json", rows: 400, gzipBytes: 80 * 1024 },
    ],
    overBudget: [],
  };

  it("reports placement, size, and the labels that named no place", () => {
    const markdown = renderSearchIndexSummary(report);
    expect(markdown).toContain("### Search index `1b3543dd7069`");
    expect(markdown).toContain(
      "- 1,000 postings: 99.0% placed (95.0% by their labels, 3.5% only by offices, addresses, or a stated country, 0.5% inferred from the company's home country), 80.0% to a city; 12 open to anywhere.",
    );
    expect(markdown).toContain("- 2 shards, 200 KB gzipped in all; the largest is 120 KB.");
    expect(markdown).toContain("most common first: Jobs.cz (5), Office   Field (2).");
    expect(markdown).not.toContain("Over budget");
    expect(markdown).not.toContain("Left out");
  });

  it("reports the placeholders it left out", () => {
    expect(renderSearchIndexSummary({ ...report, placeholders: 19 })).toContain(
      "- Left out 19 templates and tests that employers published by mistake.",
    );
  });

  it("lists budgets the build exceeds", () => {
    const markdown = renderSearchIndexSummary({
      ...report,
      overBudget: ["manifest.json is 30000 bytes (budget 20480)"],
    });
    expect(markdown).toContain("**Over budget:**\n\n- manifest.json is 30000 bytes (budget 20480)");
  });
});
