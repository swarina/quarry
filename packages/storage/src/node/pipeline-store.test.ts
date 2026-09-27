import {
  BOARD_GONE_MIN_SPAN_MS,
  boardId,
  type NormalizedPosting,
  postingContentHash,
  postingId,
} from "@quarry/domain";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type BoardRecord,
  type CrawlAttempt,
  openPipelineStore,
  type PipelineStore,
  type PreparedItem,
  type SeedBoard,
} from "./pipeline-store.ts";

const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 8, 27, 3, 17);
const ACME: SeedBoard = { source: "lever", slug: "acme", company: "Acme", country: "US" };
const ACME_ID = boardId("lever", "acme");

function posting(
  externalId: string,
  overrides: Partial<NormalizedPosting> = {},
): NormalizedPosting {
  return {
    externalId,
    title: `Engineer ${externalId}`,
    url: `https://jobs.lever.co/acme/${externalId}`,
    applyUrl: null,
    locations: ["Berlin"],
    places: [],
    country: "DE",
    workplace: null,
    employmentType: null,
    department: null,
    team: null,
    language: null,
    publishedAt: null,
    salary: null,
    descriptionHtml: `<p>Role ${externalId}</p>`,
    ...overrides,
  };
}

async function item(value: NormalizedPosting): Promise<PreparedItem> {
  return {
    kind: "posting",
    postingId: await postingId(ACME_ID, value.externalId),
    externalId: value.externalId,
    posting: value,
    contentHash: await postingContentHash(value),
    rawJson: JSON.stringify({ id: value.externalId }),
  };
}

async function invalid(externalId: string): Promise<PreparedItem> {
  return { kind: "invalid", postingId: await postingId(ACME_ID, externalId), externalId };
}

let store: PipelineStore;
let run = 0;

function attempt(at: number, runId?: string): CrawlAttempt {
  run += 1;
  const id = runId ?? `run-${run}`;
  store.startRun({ id, trigger: "local", codeVersion: "test", startedAt: at });
  return {
    runId: id,
    startedAt: at,
    finishedAt: at + 1_000,
    attempts: 1,
    bytes: 100,
    httpStatus: 200,
  };
}

function acme(): BoardRecord {
  const board = store.board(ACME_ID);
  if (board === undefined) throw new Error("board missing");
  return board;
}

function presence(externalId: string) {
  return store.db
    .prepare(
      `SELECT first_crawl_id AS first, last_crawl_id AS last FROM posting_presence
       JOIN postings ON postings.id = posting_presence.posting_id
       WHERE postings.external_id = ? ORDER BY first_crawl_id`,
    )
    .all(externalId);
}

async function list(at: number, postings: NormalizedPosting[], etag: string | null = null) {
  const items = await Promise.all(postings.map(item));
  return store.recordListing(acme(), attempt(at), { items, etag, normalizerVersion: 1 });
}

beforeEach(() => {
  store = openPipelineStore(":memory:");
  store.syncBoards([ACME], [], T0);
});

describe("syncBoards", () => {
  it("adds seeds, retires removed ones, and reactivates returning ones", () => {
    const beta: SeedBoard = { source: "ashby", slug: "Beta", company: "Beta", country: null };
    expect(store.syncBoards([ACME, beta], [], T0)).toEqual({
      added: 1,
      reactivated: 0,
      retired: 0,
      denied: 0,
      purgedPostings: 0,
    });
    expect(store.board(boardId("ashby", "beta"))?.slug).toBe("Beta");
    expect(store.syncBoards([beta], [], T0).retired).toBe(1);
    expect(acme().status).toBe("retired");
    expect(store.syncBoards([ACME, beta], [], T0).reactivated).toBe(1);
    expect(acme().status).toBe("active");
  });

  it("updates company details from the seed list", () => {
    store.syncBoards([{ ...ACME, company: "Acme Corp", country: "GB" }], [], T0);
    expect(acme()).toMatchObject({ company: "Acme Corp", country: "GB" });
  });

  it("denies boards on the removal list and deletes their postings", async () => {
    await list(T0, [posting("1"), posting("2")]);
    expect(store.syncBoards([ACME], [{ source: "lever", slug: "ACME" }], T0)).toMatchObject({
      denied: 1,
      purgedPostings: 2,
    });
    expect(acme()).toMatchObject({
      status: "denied",
      etag: null,
      lastListedCrawlId: null,
      lastListedCount: null,
    });
    expect(store.db.prepare("SELECT count(*) AS n FROM posting_presence").get()).toEqual({ n: 0 });
    expect(store.syncBoards([ACME], [{ source: "lever", slug: "acme" }], T0).denied).toBe(0);
  });

  it("records unknown boards on the removal list so discovery can never add them", () => {
    store.syncBoards([ACME], [{ source: "greenhouse", slug: "optout" }], T0);
    expect(store.board(boardId("greenhouse", "optout"))?.status).toBe("denied");
    expect(store.activeBoards().map((board) => board.id)).toEqual([ACME_ID]);
  });
});

describe("activeBoards", () => {
  it("lists never-crawled boards first, then the least recently crawled", async () => {
    const seeds: SeedBoard[] = [ACME, { ...ACME, slug: "zeta" }, { ...ACME, slug: "beta" }];
    store.syncBoards(seeds, [], T0);
    await list(T0, [posting("1")]);
    expect(store.activeBoards().map((board) => board.slug)).toEqual(["beta", "zeta", "acme"]);
  });
});

describe("recordListing", () => {
  it("records new postings with their content and first presence", async () => {
    const result = await list(T0, [posting("1"), posting("2")], 'W/"v1"');
    expect(result).toMatchObject({
      outcome: "listed",
      listed: 2,
      newPostings: 2,
      changedPostings: 0,
    });
    expect(presence("1")).toEqual([{ first: result.crawlId, last: result.crawlId }]);
    expect(acme()).toMatchObject({
      etag: 'W/"v1"',
      etagNormalizerVersion: 1,
      lastListedCrawlId: result.crawlId,
      lastListedCount: 2,
      lastSuccessAt: T0 + 1_000,
    });
    expect(store.db.prepare("SELECT count(*) AS n FROM posting_contents").get()).toEqual({ n: 2 });
  });

  it("stores a newer normalizer's reading of unchanged content, without counting an edit", async () => {
    const listWith = async (at: number, value: NormalizedPosting, normalizerVersion: number) =>
      store.recordListing(acme(), attempt(at), {
        items: [await item(value)],
        etag: null,
        normalizerVersion,
      });
    const contents = () =>
      (
        store.db
          .prepare("SELECT normalizer_version, normalized_json FROM posting_contents")
          .all() as { normalizer_version: number; normalized_json: string }[]
      ).map((row) => ({
        version: row.normalizer_version,
        places: (JSON.parse(row.normalized_json) as NormalizedPosting).places,
      }));
    const place = { label: "Berlin", text: "Berlin, Germany" };

    await listWith(T0, posting("1"), 1);
    const reread = await listWith(T0 + HOUR, posting("1", { places: [place] }), 2);
    expect(reread.changedPostings).toBe(0);
    expect(contents()).toEqual([{ version: 2, places: [place] }]);
    // An older normalizer never replaces a newer reading.
    await listWith(T0 + 2 * HOUR, posting("1"), 1);
    expect(contents()).toEqual([{ version: 2, places: [place] }]);
    expect(store.db.prepare("SELECT count(*) AS n FROM posting_changes").get()).toEqual({ n: 1 });
  });

  it("refreshes earlier content that returns under a newer normalizer", async () => {
    const listWith = async (at: number, value: NormalizedPosting, normalizerVersion: number) =>
      store.recordListing(acme(), attempt(at), {
        items: [await item(value)],
        etag: null,
        normalizerVersion,
      });
    await listWith(T0, posting("1"), 1);
    await listWith(T0 + HOUR, posting("1", { title: "Edited" }), 1);
    await listWith(T0 + 2 * HOUR, posting("1", { places: [{ label: null, text: "Berlin" }] }), 2);
    expect(
      store.db
        .prepare("SELECT normalizer_version AS version FROM posting_contents ORDER BY rowid")
        .all(),
    ).toEqual([{ version: 2 }, { version: 1 }]);
  });

  it("extends presence while a posting stays listed and starts a new run after a gap", async () => {
    const first = await list(T0, [posting("1"), posting("2")]);
    const second = await list(T0 + 24 * HOUR, [posting("1")]);
    const third = await list(T0 + 48 * HOUR, [posting("1"), posting("2")]);
    expect(presence("1")).toEqual([{ first: first.crawlId, last: third.crawlId }]);
    expect(presence("2")).toEqual([
      { first: first.crawlId, last: first.crawlId },
      { first: third.crawlId, last: third.crawlId },
    ]);
    expect(second.listed).toBe(1);
  });

  it("records every content change, including a return to earlier content", async () => {
    await list(T0, [posting("1")]);
    const edited = await list(T0 + HOUR, [posting("1", { title: "Senior Engineer 1" })]);
    await list(T0 + 2 * HOUR, [posting("1")]);
    expect(edited.changedPostings).toBe(1);
    const changes = store.db
      .prepare("SELECT content_hash FROM posting_changes ORDER BY crawl_id")
      .all();
    expect(changes).toHaveLength(3);
    expect(changes[0]).toEqual(changes[2]);
    expect(store.db.prepare("SELECT count(*) AS n FROM posting_contents").get()).toEqual({ n: 2 });
    const row = store.db.prepare("SELECT title FROM postings").get();
    expect(row).toEqual({ title: "Engineer 1" });
  });

  it("does not count unchanged content as a change", async () => {
    await list(T0, [posting("1")]);
    expect(
      (await list(T0 + HOUR, [posting("1", { url: "https://x.example/1" })])).changedPostings,
    ).toBe(0);
  });

  it("keeps a known posting present when its job fails validation, and skips unknown ones", async () => {
    const first = await list(T0, [posting("1")]);
    const items = [await invalid("1"), await invalid("2")];
    const result = store.recordListing(acme(), attempt(T0 + HOUR), {
      items,
      etag: 'W/"v2"',
      normalizerVersion: 1,
    });
    expect(result).toMatchObject({ listed: 1, invalid: 2, newPostings: 0 });
    expect(presence("1")).toEqual([{ first: first.crawlId, last: result.crawlId }]);
    expect(presence("2")).toEqual([]);
    expect(acme().etag).toBeNull();
  });

  it("stores the crawl's counts and rolls back entirely on failure", async () => {
    const first = await list(T0, [posting("1")]);
    const row = store.db.prepare("SELECT * FROM board_crawls WHERE id = ?").get(first.crawlId);
    expect(row).toMatchObject({ outcome: "listed", listed_count: 1, new_count: 1, attempts: 1 });

    const items = [await item(posting("9"))];
    const runId = "run-dup";
    const repeat = attempt(T0 + HOUR, runId);
    store.recordListing(acme(), repeat, { items, etag: null, normalizerVersion: 1 });
    expect(() =>
      store.recordListing(acme(), repeat, { items, etag: null, normalizerVersion: 1 }),
    ).toThrow(/UNIQUE/);
    expect(store.db.prepare("SELECT count(*) AS n FROM board_crawls").get()).toEqual({ n: 2 });
  });
});

describe("stale board records", () => {
  it("are ignored in favor of the stored board state", async () => {
    const stale = acme();
    const items = async (ids: string[]) => Promise.all(ids.map((id) => item(posting(id))));
    const first = store.recordListing(stale, attempt(T0), {
      items: await items(["1"]),
      etag: null,
      normalizerVersion: 1,
    });
    const second = store.recordListing(stale, attempt(T0 + HOUR), {
      items: await items(["1"]),
      etag: null,
      normalizerVersion: 1,
    });
    expect(presence("1")).toEqual([{ first: first.crawlId, last: second.crawlId }]);
    const notFound = { kind: "not-found", code: "not-found", message: null } as const;
    store.recordFailure(stale, attempt(T0 + 2 * HOUR), notFound);
    store.recordFailure(stale, attempt(T0 + 3 * HOUR), notFound);
    expect(acme().notFoundCount).toBe(2);
  });
});

describe("recordNotModified", () => {
  it("extends the presence of everything in the previous listing", async () => {
    const first = await list(T0, [posting("1"), posting("2")], 'W/"v1"');
    const result = store.recordNotModified(acme(), attempt(T0 + 24 * HOUR));
    expect(result).toMatchObject({ outcome: "not-modified", listed: 2 });
    expect(presence("1")).toEqual([{ first: first.crawlId, last: result.crawlId }]);
    expect(acme()).toMatchObject({ etag: 'W/"v1"', lastListedCrawlId: result.crawlId });
    const seen = store.db
      .prepare("SELECT DISTINCT last_seen_crawl_id AS crawl FROM postings")
      .all();
    expect(seen).toEqual([{ crawl: result.crawlId }]);
  });

  it("refuses a board that was never listed", () => {
    expect(() => store.recordNotModified(acme(), attempt(T0))).toThrow(/no earlier listing/);
  });
});

describe("recordFailure", () => {
  it("counts consecutive failures and resets them on success", async () => {
    store.recordFailure(acme(), attempt(T0), { kind: "failed", code: "timeout", message: null });
    store.recordFailure(acme(), attempt(T0 + HOUR), {
      kind: "failed",
      code: "timeout",
      message: null,
    });
    expect(acme().consecutiveFailures).toBe(2);
    await list(T0 + 2 * HOUR, [posting("1")]);
    expect(acme().consecutiveFailures).toBe(0);
  });

  it("declares a board gone only after repeated 404s over enough time", async () => {
    await list(T0, [posting("1")]);
    const notFound = { kind: "not-found", code: "not-found", message: null } as const;
    expect(store.recordFailure(acme(), attempt(T0 + HOUR), notFound).outcome).toBe("not-found");
    expect(store.recordFailure(acme(), attempt(T0 + 2 * HOUR), notFound).outcome).toBe("not-found");
    expect(store.recordFailure(acme(), attempt(T0 + 3 * HOUR), notFound).outcome).toBe("not-found");
    const late = T0 + HOUR + BOARD_GONE_MIN_SPAN_MS;
    expect(store.recordFailure(acme(), attempt(late), notFound).outcome).toBe("board-gone");
    expect(acme().status).toBe("gone");
    expect(store.activeBoards()).toEqual([]);
  });

  it("forgets earlier 404s after a successful crawl", async () => {
    const notFound = { kind: "not-found", code: "not-found", message: null } as const;
    store.recordFailure(acme(), attempt(T0), notFound);
    await list(T0 + HOUR, [posting("1")]);
    expect(acme()).toMatchObject({ notFoundCount: 0, notFoundSince: null });
  });
});

describe("runSummary", () => {
  it("summarizes a run's crawls by source and outcome, and lists failures", async () => {
    store.syncBoards(
      [ACME, { source: "ashby", slug: "beta", company: "Beta", country: null }],
      [],
      T0,
    );
    const runId = "summary-run";
    const at = attempt(T0, runId);
    store.recordListing(acme(), at, {
      items: [await item(posting("1")), await item(posting("2"))],
      etag: null,
      normalizerVersion: 1,
    });
    const beta = store.board(boardId("ashby", "beta"));
    if (beta === undefined) throw new Error("beta missing");
    store.recordFailure(
      beta,
      { ...at, httpStatus: 503 },
      {
        kind: "failed",
        code: "server-error",
        message: "HTTP 503",
      },
    );
    expect(store.runSummary(runId)).toEqual({
      runId,
      bySource: [
        {
          source: "ashby",
          outcome: "failed",
          crawls: 1,
          newPostings: 0,
          changedPostings: 0,
          invalid: 0,
          bytes: 100,
          attempts: 1,
        },
        {
          source: "lever",
          outcome: "listed",
          crawls: 1,
          newPostings: 2,
          changedPostings: 0,
          invalid: 0,
          bytes: 100,
          attempts: 1,
        },
      ],
      failures: [
        {
          boardId: "ashby:beta",
          outcome: "failed",
          httpStatus: 503,
          errorCode: "server-error",
          errorMessage: "HTTP 503",
        },
      ],
      activeBoards: 2,
      listedPostings: 2,
      knownPostings: 2,
    });
  });
});

describe("freshnessSamples", () => {
  it("times new postings from their publish time, skipping a board's first listing", async () => {
    /** Lists `jobs`, each an external id with the publish time its ATS states. */
    const listing = async (
      at: number,
      runId: string,
      board: BoardRecord,
      jobs: [string, number | null][],
    ) => {
      const items = await Promise.all(
        jobs.map(async ([externalId, publishedAt]) => {
          const value = posting(externalId, { publishedAt });
          return {
            kind: "posting" as const,
            postingId: await postingId(board.id, externalId),
            externalId,
            posting: value,
            contentHash: await postingContentHash(value),
            rawJson: "{}",
          };
        }),
      );
      store.recordListing(board, attempt(at, runId), { items, etag: null, normalizerVersion: 1 });
    };
    store.syncBoards(
      [ACME, { source: "ashby", slug: "beta", company: "Beta", country: null }],
      [],
      T0,
    );
    const beta = store.board(boardId("ashby", "beta"));
    if (beta === undefined) throw new Error("beta missing");
    const old = T0 - 100 * HOUR;
    const later = T0 + 24 * HOUR;

    await listing(T0, "first", acme(), [["old", old]]);
    await listing(later, "second", acme(), [
      ["old", old],
      ["new", later - 4 * HOUR],
      ["undated", null],
    ]);
    // Beta's first listing: everything on it is new to us, so none of it is timed.
    await listing(later, "second-beta", beta, [["new", later - 4 * HOUR]]);

    const samples = store.freshnessSamples(T0);
    expect(samples).toHaveLength(2);
    // A crawl's postings are first seen when it finishes, a second after it starts here.
    expect(samples).toContainEqual({
      runId: "second",
      source: "lever",
      latencyMs: 4 * HOUR + 1_000,
    });
    expect(samples).toContainEqual({ runId: "second", source: "lever", latencyMs: null });
    expect(store.freshnessSamples(later + 2_000)).toEqual([]);
  });
});

describe("currentPostings", () => {
  it("reads what each board's latest listing includes, without descriptions", async () => {
    const berlin = { label: null, text: "Berlin, Germany" };
    await list(T0, [posting("1"), posting("2", { places: [berlin] })]);
    await list(T0 + HOUR, [posting("2", { places: [berlin] })]);
    const current = [...store.currentPostings()];
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({
      company: "Acme",
      companyCountry: "US",
      firstSeenAt: T0 + 1_000,
      posting: { externalId: "2", title: "Engineer 2", places: [berlin] },
    });
    expect(current[0]?.posting).not.toHaveProperty("descriptionHtml");
  });

  it("gives content stored before places existed no places", async () => {
    const { places: _, ...older } = posting("1");
    await list(T0, [older as NormalizedPosting]);
    expect([...store.currentPostings()][0]?.posting.places).toEqual([]);
  });

  it("leaves out boards that are no longer active", async () => {
    await list(T0, [posting("1")]);
    store.syncBoards([], [], T0);
    expect([...store.currentPostings()]).toEqual([]);
  });
});

describe("meta and runs", () => {
  it("stores metadata and run status", () => {
    expect(store.getMeta("snapshot_seq")).toBeUndefined();
    store.setMeta("snapshot_seq", "4");
    store.setMeta("snapshot_seq", "5");
    expect(store.getMeta("snapshot_seq")).toBe("5");
    store.startRun({ id: "r", trigger: "schedule", codeVersion: "abc", startedAt: T0 });
    store.finishRun("r", "succeeded", T0 + HOUR);
    expect(store.db.prepare("SELECT status, finished_at FROM runs WHERE id = 'r'").get()).toEqual({
      status: "succeeded",
      finished_at: T0 + HOUR,
    });
    store.close();
  });
});
