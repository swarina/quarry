import { boardId, type NormalizedPosting, postingContentHash, postingId } from "@quarry/domain";
import { type JevClient, JevError } from "@quarry/jev";
import { STANDARD_QUESTIONS } from "@quarry/questions";
import { openPipelineStore, type PipelineStore, type SeedBoard } from "@quarry/storage/node";
import { beforeEach, describe, expect, it } from "vitest";
import { enrichPostings, estimateEnrichment } from "./enrich.ts";
import { createLogger } from "./log.ts";

const T0 = Date.UTC(2026, 9, 4, 3, 17);
const ACME: SeedBoard = { source: "greenhouse", slug: "acme", company: "Acme", country: "US" };
const ACME_ID = boardId("greenhouse", "acme");
const QUIET = createLogger("pipeline", () => {});

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
    descriptionHtml: "<p>We need an engineer. Remote within Germany.</p>",
    ...overrides,
  };
}

let listings = 0;

async function list(postings: readonly NormalizedPosting[]): Promise<void> {
  listings += 1;
  const runId = `crawl-${listings}`;
  store.startRun({ id: runId, trigger: "local", codeVersion: "test", startedAt: T0 });
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
    { runId, startedAt: T0, finishedAt: T0, attempts: 1, bytes: 0, httpStatus: 200 },
    { items, etag: null, normalizerVersion: 2 },
  );
}

/** A client that answers every question without a network, counting what it was asked. */
function fakeClient(
  behaviour: (seen: number) => "answer" | Error = () => "answer",
): JevClient & { readonly states: unknown[] } {
  const states: unknown[] = [];
  return {
    model: "jev-1.13.0",
    states,
    async ask(request) {
      const outcome = behaviour(states.length);
      states.push(request.state);
      if (outcome !== "answer") throw outcome;
      const answers = Object.fromEntries(
        Object.keys(request.questions).map((id) => [id, { type: "noul", noul: 0.5 }]),
      );
      return {
        model: "jev-1.13.0",
        answers: answers as never,
        usage: { inputTokens: 100, outputTokens: 10, costNanoUsd: 10_000 },
        requestId: "req",
        latencyMs: 1,
      };
    },
  };
}

const options = (client: JevClient, overrides: Record<string, unknown> = {}) => ({
  store,
  client,
  runId: "run-1",
  maxPostings: 100,
  budgetNanoUsd: 1_000_000_000,
  deadline: Number.POSITIVE_INFINITY,
  concurrency: 2,
  log: QUIET,
  ...overrides,
});

beforeEach(() => {
  store = openPipelineStore(":memory:");
  store.syncBoards([ACME], [], T0);
  listings = 0;
  // The enrichment records its spend against a run of its own.
  store.startRun({ id: "run-1", trigger: "local", codeVersion: "test", startedAt: T0 });
});

describe("enrichPostings", () => {
  it("asks every question about each posting once and stores the answers", async () => {
    await list([posting("1"), posting("2")]);
    const client = fakeClient();
    const report = await enrichPostings(options(client));

    expect(report).toMatchObject({ outstanding: 2, asked: 2, answered: 2, failed: 0 });
    expect(client.states).toHaveLength(2);
    // One request per posting, with every question in it: postings are never packed together.
    const rows = store.db
      .prepare("SELECT question_id, count(*) AS n FROM posting_answers GROUP BY 1")
      .all() as { question_id: string; n: number }[];
    expect(rows).toHaveLength(STANDARD_QUESTIONS.length);
    for (const row of rows) expect(row.n).toBe(2);
  });

  it("sends the posting as text, not as the HTML a board wrote", async () => {
    await list([posting("1")]);
    const client = fakeClient();
    await enrichPostings(options(client));
    const state = client.states[0] as { posting: { description: string; title: string } };
    expect(state.posting.description).toBe("We need an engineer. Remote within Germany.");
    expect(state.posting.title).toBe("Engineer 1");
  });

  it("never pays twice for content it has already answered", async () => {
    await list([posting("1"), posting("2")]);
    await enrichPostings(options(fakeClient()));
    const again = fakeClient();
    const report = await enrichPostings(options(again));
    expect(report).toMatchObject({ outstanding: 0, asked: 0, answered: 0 });
    expect(again.states).toHaveLength(0);
  });

  it("asks again when a posting's content changes", async () => {
    await list([posting("1")]);
    await enrichPostings(options(fakeClient()));
    await list([posting("1", { descriptionHtml: "<p>Now it is an on-call role.</p>" })]);
    const client = fakeClient();
    const report = await enrichPostings(options(client));
    expect(report).toMatchObject({ outstanding: 1, answered: 1 });
  });

  it("stops starting requests once the run has spent its budget", async () => {
    await list(Array.from({ length: 20 }, (_, index) => posting(String(index))));
    const client = fakeClient();
    // Three requests' worth, so it stops well short of twenty.
    const report = await enrichPostings(options(client, { budgetNanoUsd: 30_000 }));
    expect(report.stoppedBy).toBe("budget");
    expect(report.answered).toBeLessThan(20);
    expect(report.costNanoUsd).toBeGreaterThanOrEqual(30_000);
  });

  it("stops at its deadline rather than overrunning the run", async () => {
    await list(Array.from({ length: 10 }, (_, index) => posting(String(index))));
    let clock = T0;
    const report = await enrichPostings(
      options(fakeClient(), {
        deadline: T0 + 5,
        now: () => {
          clock += 2;
          return clock;
        },
      }),
    );
    expect(report.stoppedBy).toBe("deadline");
    expect(report.answered).toBeLessThan(10);
  });

  it("gives up after failures in a row, which say the problem is not this posting", async () => {
    await list(Array.from({ length: 20 }, (_, index) => posting(String(index))));
    const client = fakeClient(() => new JevError("SERVER", "upstream is unwell"));
    const report = await enrichPostings(options(client, { concurrency: 1 }));
    expect(report.stoppedBy).toBe("errors");
    expect(report.answered).toBe(0);
    expect(report.asked).toBeLessThan(20);
    expect(report.errors[0]?.message).toContain("upstream is unwell");
  });

  it("keeps going when one posting fails on its own", async () => {
    await list([posting("1"), posting("2"), posting("3")]);
    const client = fakeClient((seen) =>
      seen === 0 ? new JevError("INVALID_RESPONSE", "nonsense") : "answer",
    );
    const report = await enrichPostings(options(client, { concurrency: 1 }));
    expect(report).toMatchObject({ asked: 3, answered: 2, failed: 1 });
  });

  it("treats a refused spend as the budget speaking, not as a bad posting", async () => {
    await list(Array.from({ length: 5 }, (_, index) => posting(String(index))));
    const client = fakeClient(() => new JevError("BUDGET_EXCEEDED", "over the limit"));
    const report = await enrichPostings(options(client, { concurrency: 1 }));
    expect(report.stoppedBy).toBe("budget");
    expect(report.asked).toBe(1);
  });

  it("records what the run cost, so spend can be audited against the ledger", async () => {
    await list([posting("1"), posting("2")]);
    await enrichPostings(options(fakeClient()));
    const row = store.db.prepare("SELECT * FROM enrichment_runs").get() as Record<string, number>;
    expect(row).toMatchObject({ asked: 2, failed: 0, input_tokens: 200, cost_nano_usd: 20_000 });
  });
});

describe("estimateEnrichment", () => {
  it("costs the work before any of it is paid for", async () => {
    await list([posting("1"), posting("2")]);
    const estimate = estimateEnrichment(store, 10);
    expect(estimate.outstanding).toBe(2);
    expect(estimate.perPostingNanoUsd).toBeGreaterThan(0);
    expect(estimate.totalNanoUsd).toBe(estimate.perPostingNanoUsd * 2);
  });

  it("says nothing is outstanding once everything is answered", async () => {
    await list([posting("1")]);
    await enrichPostings(options(fakeClient()));
    expect(estimateEnrichment(store, 10)).toMatchObject({ outstanding: 0, totalNanoUsd: 0 });
  });
});
