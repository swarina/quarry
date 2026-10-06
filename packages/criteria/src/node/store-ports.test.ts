import { boardId, type NormalizedPosting, postingContentHash, postingId } from "@quarry/domain";
import type { JevClient } from "@quarry/jev";
import { openPipelineStore, type PipelineStore, type SeedBoard } from "@quarry/storage/node";
import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryBudgetStore } from "../budget.ts";
import { readCriterion } from "../criterion.ts";
import { createCriteriaHandler } from "../handler.ts";
import {
  createStoreAnswerCache,
  createStoreBudgetStore,
  createStorePostingSource,
} from "./store-ports.ts";

/**
 * The ports against a real store, which is what shows the schema, the prefix resolution and the
 * persistence actually work. The package's other tests use the in-memory ports.
 */

const T0 = Date.UTC(2026, 9, 6, 3, 17);
const ACME: SeedBoard = { source: "greenhouse", slug: "acme", company: "Acme", country: "US" };
const ACME_ID = boardId("greenhouse", "acme");
const MODEL = "jev-1.13.0";
const SECRET = "a-long-enough-shared-secret";
const CENT = 10_000_000;

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
    locations: ["Berlin"],
    places: [],
    country: null,
    workplace: null,
    employmentType: null,
    department: null,
    team: null,
    language: null,
    publishedAt: T0,
    salary: null,
    descriptionHtml: "<p>Run the <b>platform</b>.</p><ul><li>On call</li></ul>",
    ...overrides,
  };
}

async function list(postings: NormalizedPosting[], at = T0): Promise<void> {
  store.startRun({ id: `run-${at}`, trigger: "local", codeVersion: "test", startedAt: at });
  const board = store.board(ACME_ID);
  if (board === undefined) throw new Error("board missing");
  const items = await Promise.all(
    postings.map(async (value) => ({
      kind: "posting" as const,
      postingId: await postingId(ACME_ID, value.externalId),
      externalId: value.externalId,
      posting: value,
      contentHash: await postingContentHash(value),
      rawJson: JSON.stringify({ id: value.externalId }),
    })),
  );
  store.recordListing(
    board,
    {
      runId: `run-${at}`,
      startedAt: at,
      finishedAt: at + 1_000,
      attempts: 1,
      bytes: 10,
      httpStatus: 200,
    },
    { items, etag: null, normalizerVersion: 1 },
  );
}

beforeEach(() => {
  store = openPipelineStore(":memory:");
  store.syncBoards([ACME], [], T0);
});

function stubClient(): JevClient & { readonly calls: () => number } {
  let calls = 0;
  return {
    model: MODEL,
    ask(request) {
      calls += 1;
      return Promise.resolve({
        model: MODEL,
        answers: Object.fromEntries(
          Object.keys(request.questions).map((id) => [id, { type: "noul", noul: 0.9 }]),
        ) as never,
        usage: { inputTokens: 100, outputTokens: 0, costNanoUsd: 4_200 },
        requestId: undefined,
        latencyMs: 1,
      });
    },
    calls: () => calls,
  };
}

describe("posting text from the store", () => {
  it("resolves an id prefix to the posting, as text rather than markup", async () => {
    await list([posting("1")]);
    const id = await postingId(ACME_ID, "1");
    const source = createStorePostingSource(store);
    const found = await source.read([id.slice(0, 10)]);
    expect(found).toHaveLength(1);
    expect(found[0]?.id).toBe(id);
    expect(found[0]?.company).toBe("Acme");
    expect(found[0]?.title).toBe("Engineer 1");
    // The model is given text: no tags, and the list became a dash line.
    expect(found[0]?.description).toContain("Run the platform.");
    expect(found[0]?.description).not.toContain("<b>");
  });

  it("carries the content hash, which is what the cache is keyed on", async () => {
    const value = posting("1");
    await list([value]);
    const source = createStorePostingSource(store);
    const found = await source.read([(await postingId(ACME_ID, "1")).slice(0, 10)]);
    expect(found[0]?.contentHash).toBe(await postingContentHash(value));
  });

  it("resolves a full id as well as a prefix", async () => {
    await list([posting("1")]);
    const id = await postingId(ACME_ID, "1");
    const found = await createStorePostingSource(store).read([id]);
    expect(found[0]?.id).toBe(id);
  });

  it("leaves out a prefix that matches nothing", async () => {
    await list([posting("1")]);
    expect(await createStorePostingSource(store).read(["ZZZZZZZZZZ"])).toEqual([]);
  });

  it("leaves out an ambiguous prefix rather than guessing", async () => {
    await list([posting("1"), posting("2")]);
    const first = await postingId(ACME_ID, "1");
    // One character is near-certain to match both of two ids.
    const shared = first.slice(0, 1);
    const found = await createStorePostingSource(store).read([shared]);
    expect(found.length).toBeLessThanOrEqual(1);
    // With two postings under one prefix it must resolve to none, not to either.
    const ambiguous = (await createStorePostingSource(store).read([""])).length;
    expect(ambiguous).toBe(0);
  });

  it("leaves out postings of a board that is no longer active", async () => {
    await list([posting("1")]);
    const id = await postingId(ACME_ID, "1");
    store.syncBoards([], [], T0);
    expect(await createStorePostingSource(store).read([id])).toEqual([]);
  });
});

describe("the answer cache in the store", () => {
  it("keeps an answer and reads it back", async () => {
    const cache = createStoreAnswerCache(store, () => T0);
    await cache.write("criterion-1", MODEL, [{ contentHash: "hash-a", answerJson: '{"a":1}' }]);
    expect(await cache.read("criterion-1", MODEL, ["hash-a"])).toEqual([
      { contentHash: "hash-a", answerJson: '{"a":1}' },
    ]);
  });

  it("keeps answers from different models apart", async () => {
    const cache = createStoreAnswerCache(store, () => T0);
    await cache.write("criterion-1", MODEL, [{ contentHash: "hash-a", answerJson: '{"old":1}' }]);
    await cache.write("criterion-1", "jev-2.0.0", [
      { contentHash: "hash-a", answerJson: '{"new":1}' },
    ]);
    // A calibrated answer belongs to the model that produced it (ADR-0004).
    expect(await cache.read("criterion-1", MODEL, ["hash-a"])).toEqual([
      { contentHash: "hash-a", answerJson: '{"old":1}' },
    ]);
  });

  it("keeps criteria apart, so one wording's answer is not served for another", async () => {
    const cache = createStoreAnswerCache(store, () => T0);
    await cache.write("criterion-1", MODEL, [{ contentHash: "hash-a", answerJson: '{"a":1}' }]);
    expect(await cache.read("criterion-2", MODEL, ["hash-a"])).toEqual([]);
  });

  it("asks for nothing when given no hashes", async () => {
    expect(await createStoreAnswerCache(store).read("criterion-1", MODEL, [])).toEqual([]);
  });

  it("replaces an answer asked again", async () => {
    const cache = createStoreAnswerCache(store, () => T0);
    await cache.write("criterion-1", MODEL, [{ contentHash: "hash-a", answerJson: '{"v":1}' }]);
    await cache.write("criterion-1", MODEL, [{ contentHash: "hash-a", answerJson: '{"v":2}' }]);
    expect(await cache.read("criterion-1", MODEL, ["hash-a"])).toEqual([
      { contentHash: "hash-a", answerJson: '{"v":2}' },
    ]);
  });
});

describe("the daily budget in the store", () => {
  it("survives a reopened store, which is the point of persisting it", async () => {
    const budget = createStoreBudgetStore(store);
    expect(await budget.reserve("2026-10-06", CENT, 2 * CENT)).toBe(CENT);
    // A new store object over the same database: a restart must not hand the day back.
    const again = createStoreBudgetStore(store);
    expect(await again.committed("2026-10-06")).toBe(CENT);
    expect(await again.reserve("2026-10-06", CENT, 2 * CENT)).toBe(CENT);
    expect(await again.reserve("2026-10-06", CENT, 2 * CENT)).toBe(0);
  });

  it("gives out only what the day has left", async () => {
    const budget = createStoreBudgetStore(store);
    expect(await budget.reserve("2026-10-06", CENT, CENT + 500)).toBe(CENT);
    expect(await budget.reserve("2026-10-06", CENT, CENT + 500)).toBe(500);
  });

  it("releases what was not spent", async () => {
    const budget = createStoreBudgetStore(store);
    await budget.reserve("2026-10-06", CENT, 10 * CENT);
    await budget.release("2026-10-06", CENT - 1_000);
    expect(await budget.committed("2026-10-06")).toBe(1_000);
  });

  it("counts each day on its own", async () => {
    const budget = createStoreBudgetStore(store);
    await budget.reserve("2026-10-06", CENT, CENT);
    expect(await budget.reserve("2026-10-07", CENT, CENT)).toBe(CENT);
  });
});

describe("the whole path against a real store", () => {
  it("answers a criterion, then answers it again for free", async () => {
    await list([posting("1"), posting("2")]);
    const [first, second] = await Promise.all([postingId(ACME_ID, "1"), postingId(ACME_ID, "2")]);
    const client = stubClient();
    const handler = createCriteriaHandler({
      secret: SECRET,
      model: MODEL,
      postings: createStorePostingSource(store),
      cache: createStoreAnswerCache(store, () => T0),
      budget: createStoreBudgetStore(store),
      limits: { perRequestNanoUsd: CENT, perDayNanoUsd: 10 * CENT },
      client: () => client,
    });
    const body = {
      criteria: [{ kind: "yes-no", question: "Is the on-call heavy?" }],
      postings: [first.slice(0, 10), second.slice(0, 10)],
    };
    const request = () =>
      new Request("https://quarry.example/criteria/ask", {
        method: "POST",
        headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const response = await handler(request());
    expect(response.status).toBe(200);
    const answered = (await response.json()) as {
      answers: { id: string; answers: { distribution: number[]; cached: boolean }[] }[];
      report: { asked: number; cached: number; postings: number };
    };
    expect(answered.report).toMatchObject({ postings: 2, asked: 2, cached: 0 });
    expect(answered.answers[0]?.answers[0]?.distribution).toEqual([10, 90]);
    expect(client.calls()).toBe(2);

    // Asked again: the store kept the answers, so nothing is paid for twice.
    const repeat = await handler(request());
    const again = (await repeat.json()) as {
      report: { asked: number; cached: number; costNanoUsd: number };
    };
    expect(again.report).toMatchObject({ asked: 0, cached: 2, costNanoUsd: 0 });
    expect(client.calls()).toBe(2);
  });

  it("charges the day what the request cost, and no more", async () => {
    await list([posting("1")]);
    const id = await postingId(ACME_ID, "1");
    const handler = createCriteriaHandler({
      secret: SECRET,
      model: MODEL,
      postings: createStorePostingSource(store),
      cache: createStoreAnswerCache(store, () => T0),
      budget: createStoreBudgetStore(store),
      limits: { perRequestNanoUsd: CENT, perDayNanoUsd: 10 * CENT },
      client: () => stubClient(),
      now: () => T0,
    });
    await handler(
      new Request("https://quarry.example/criteria/ask", {
        method: "POST",
        headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
        body: JSON.stringify({
          criteria: [{ kind: "yes-no", question: "Is the on-call heavy?" }],
          postings: [id],
        }),
      }),
    );
    // One request at 4,200: the day is charged that, not a whole allowance.
    expect(store.committedCriterionSpend("2026-10-06")).toBe(4_200);
  });

  it("shares an answer between the store-backed and in-memory budgets alike", async () => {
    // The ports are interchangeable: the handler does not know which it has.
    await list([posting("1")]);
    const id = await postingId(ACME_ID, "1");
    const handler = createCriteriaHandler({
      secret: SECRET,
      model: MODEL,
      postings: createStorePostingSource(store),
      cache: createStoreAnswerCache(store, () => T0),
      budget: createMemoryBudgetStore(),
      limits: { perRequestNanoUsd: CENT, perDayNanoUsd: 10 * CENT },
      client: () => stubClient(),
    });
    const response = await handler(
      new Request("https://quarry.example/criteria/ask", {
        method: "POST",
        headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
        body: JSON.stringify({
          criteria: [{ kind: "yes-no", question: "Is the on-call heavy?" }],
          postings: [id],
        }),
      }),
    );
    expect(response.status).toBe(200);
  });

  it("asks a criterion about a reworded question separately", async () => {
    await list([posting("1")]);
    const id = await postingId(ACME_ID, "1");
    const client = stubClient();
    const handler = createCriteriaHandler({
      secret: SECRET,
      model: MODEL,
      postings: createStorePostingSource(store),
      cache: createStoreAnswerCache(store, () => T0),
      budget: createStoreBudgetStore(store),
      limits: { perRequestNanoUsd: CENT, perDayNanoUsd: 10 * CENT },
      client: () => client,
    });
    const askWith = (question: string) =>
      handler(
        new Request("https://quarry.example/criteria/ask", {
          method: "POST",
          headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
          body: JSON.stringify({ criteria: [{ kind: "yes-no", question }], postings: [id] }),
        }),
      );
    await askWith("Is the on-call heavy?");
    await askWith("Is the on-call heavy, really?");
    // A wording is the question (ADR-0024), so the second is not served from the first.
    expect(client.calls()).toBe(2);
    const criterion = await readCriterion({ kind: "yes-no", question: "Is the on-call heavy?" });
    expect(store.criterionAnswers(criterion.id, MODEL, ["any"])).toEqual([]);
  });
});
