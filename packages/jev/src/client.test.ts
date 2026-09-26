import { describe, expect, it } from "vitest";
import { createJevClient, type JevClientOptions } from "./client.ts";
import { JevError } from "./errors.ts";
import { createMemoryLedger } from "./ledger.ts";
import { JEV_MODEL } from "./model.ts";
import type { Fetch } from "./questions.ts";
import { choice, noul, score } from "./questions.ts";
import type { RateLimiter } from "./rate-limiter.ts";
import { createSpendLimit } from "./spend-limit.ts";

const questions = {
  arrangement: choice("What work arrangement does `posting` offer?", {
    remote: null,
    hybrid: null,
    onsite: null,
    not_stated: null,
  }),
  requiresGo: noul("Does `posting` require experience with Go?"),
  seniority: score("How senior is the role in `posting`?", ["Entry", "Mid", "Senior"]),
};

/** A loosely typed response body, so tests can corrupt any part of it. */
interface ResponseBody {
  model: string;
  answers: Record<string, Record<string, unknown>>;
  usage: Record<string, number>;
}

function validBody(overrides: Partial<ResponseBody> = {}): ResponseBody {
  return {
    model: JEV_MODEL,
    answers: {
      arrangement: {
        type: "choice",
        choice: "remote",
        confidence: 0.9,
        probabilities: { remote: 0.95, hybrid: 0.05, onsite: 0, not_stated: 0 },
      },
      requiresGo: { type: "noul", noul: 0.12 },
      seniority: {
        type: "score",
        score: 1.8,
        confidence: 0.7,
        legend: { "0": "Entry", "1": "Mid", "2": "Senior" },
        probabilities: { "0": 0.05, "1": 0.1, "2": 0.85 },
      },
    },
    usage: { input_tokens: 1000, output_tokens: 40 },
    ...overrides,
  };
}

function withAnswer(id: string, patch: Record<string, unknown>): ResponseBody {
  const body = validBody();
  body.answers[id] = { ...body.answers[id], ...patch };
  return body;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

interface RecordedCall {
  readonly url: string;
  readonly body: unknown;
  readonly headers: Headers;
}

function fakeApi(respond: () => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const fetch: Fetch = async (input, init) => {
    calls.push({
      url: input,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      headers: new Headers(init?.headers),
    });
    return respond();
  };
  return { fetch, calls };
}

function clientWith(fetch: Fetch, options: Partial<JevClientOptions> = {}) {
  let clock = 1_000;
  return createJevClient({
    apiKey: "test-key",
    fetch,
    maxRetries: 0,
    now: () => {
      clock += 5;
      return clock;
    },
    ...options,
  });
}

const request = { purpose: "test", state: { posting: "Senior Go engineer, remote" }, questions };

describe("createJevClient", () => {
  it("returns typed answers with usage, cost, and request id", async () => {
    const api = fakeApi(() => jsonResponse(validBody(), 200, { "x-typesafe-request-id": "req_1" }));
    const result = await clientWith(api.fetch).ask(request);

    expect(result.answers.arrangement.choice).toBe("remote");
    expect(result.answers.requiresGo.noul).toBe(0.12);
    expect(result.answers.seniority.score).toBe(1.8);
    expect(result.answers.seniority.legend["2"]).toBe("Senior");
    expect(result.usage).toEqual({ inputTokens: 1000, outputTokens: 40, costNanoUsd: 42_000 });
    expect(result.requestId).toBe("req_1");
    expect(result.model).toBe(JEV_MODEL);
    expect(result.latencyMs).toBe(5);
  });

  it("sends the pinned model and authenticates with the API key", async () => {
    const api = fakeApi(() => jsonResponse(validBody()));
    await clientWith(api.fetch).ask(request);

    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]?.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(api.calls[0]?.body).toMatchObject({ model: JEV_MODEL, state: request.state });
    expect(api.calls[0]?.headers.get("authorization")).toBe("Bearer test-key");
  });

  it("rejects answers produced by a different model", async () => {
    const api = fakeApi(() => jsonResponse(validBody({ model: "jev-9.9.9" })));
    await expect(clientWith(api.fetch).ask(request)).rejects.toMatchObject({
      code: "MODEL_MISMATCH",
    });
  });

  it.each([
    ["an unknown choice", { choice: "anywhere" }],
    [
      "a distribution that does not sum to 1",
      { probabilities: { remote: 0.5, hybrid: 0, onsite: 0, not_stated: 0 } },
    ],
    ["a missing option", { probabilities: { remote: 0.95, hybrid: 0.05, onsite: 0 } }],
    [
      "an extra option",
      { probabilities: { remote: 0.9, hybrid: 0.1, onsite: 0, not_stated: 0, other: 0 } },
    ],
    ["a confidence above 1", { confidence: 1.5 }],
  ])("rejects a choice answer with %s", async (_label, patch) => {
    const api = fakeApi(() => jsonResponse(withAnswer("arrangement", patch)));
    await expect(clientWith(api.fetch).ask(request)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("rejects a response that is missing an answer or adds one", async () => {
    const partial = Object.fromEntries(
      Object.entries(validBody().answers).filter(([id]) => id !== "requiresGo"),
    );
    const missing = fakeApi(() => jsonResponse(validBody({ answers: partial })));
    await expect(clientWith(missing.fetch).ask(request)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });

    const extra = fakeApi(() =>
      jsonResponse(
        validBody({ answers: { ...validBody().answers, bonus: { type: "noul", noul: 1 } } }),
      ),
    );
    await expect(clientWith(extra.fetch).ask(request)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("rejects a score outside its levels", async () => {
    const api = fakeApi(() => jsonResponse(withAnswer("seniority", { score: 2.5 })));
    await expect(clientWith(api.fetch).ask(request)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it.each([
    [401, "AUTHENTICATION", false],
    [403, "PERMISSION_DENIED", false],
    [422, "INVALID_REQUEST", false],
    [429, "RATE_LIMITED", true],
    [500, "SERVER", true],
    [529, "OVERLOADED", true],
  ])("maps HTTP %i to %s", async (status, code, retryable) => {
    const api = fakeApi(() =>
      jsonResponse({ error: { message: "nope" } }, status, { "x-typesafe-request-id": "req_9" }),
    );
    const failure = await clientWith(api.fetch)
      .ask(request)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(JevError);
    expect(failure).toMatchObject({ code, retryable, status, requestId: "req_9" });
  });

  it("maps network failures to CONNECTION", async () => {
    const api = fakeApi(() => {
      throw new TypeError("fetch failed");
    });
    await expect(clientWith(api.fetch).ask(request)).rejects.toMatchObject({
      code: "CONNECTION",
      retryable: true,
    });
  });

  it("maps a caller abort to ABORTED", async () => {
    const api = fakeApi(() => jsonResponse(validBody()));
    const controller = new AbortController();
    controller.abort();
    await expect(
      clientWith(api.fetch).ask({ ...request, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("validates questions before spending anything", async () => {
    const api = fakeApi(() => jsonResponse(validBody()));
    const client = clientWith(api.fetch);
    const tooFewOptions = { only: choice("Pick one", { a: null }) };
    const elevenLevels = Array.from({ length: 11 }, (_, level) => `Level ${level}`);
    const tooManyLevels = { level: score("Rate it", elevenLevels as [string, string]) };
    const noInstructions = { blank: noul("  ") };

    for (const invalid of [{}, tooFewOptions, tooManyLevels, noInstructions]) {
      await expect(client.ask({ ...request, questions: invalid })).rejects.toMatchObject({
        code: "INVALID_QUESTIONS",
      });
    }
    expect(api.calls).toHaveLength(0);
  });

  describe("with a spend limit", () => {
    it("refuses a request whose upper-bound cost does not fit, without calling the API", async () => {
      const api = fakeApi(() => jsonResponse(validBody()));
      const spendLimit = createSpendLimit({ limitNanoUsd: 1_000 });
      await expect(clientWith(api.fetch, { spendLimit }).ask(request)).rejects.toMatchObject({
        code: "BUDGET_EXCEEDED",
      });
      expect(api.calls).toHaveLength(0);
    });

    it("settles to the actual cost after a successful call", async () => {
      const api = fakeApi(() => jsonResponse(validBody()));
      const spendLimit = createSpendLimit({ limitNanoUsd: 10_000_000 });
      await clientWith(api.fetch, { spendLimit }).ask(request);
      expect(spendLimit.spentNanoUsd()).toBe(42_000);
      expect(spendLimit.reservedNanoUsd()).toBe(0);
    });

    it("releases the hold when the call fails", async () => {
      const api = fakeApi(() => jsonResponse({}, 500));
      const spendLimit = createSpendLimit({ limitNanoUsd: 10_000_000 });
      await expect(clientWith(api.fetch, { spendLimit }).ask(request)).rejects.toBeInstanceOf(
        JevError,
      );
      expect(spendLimit.spentNanoUsd()).toBe(0);
      expect(spendLimit.reservedNanoUsd()).toBe(0);
    });
  });

  describe("with a ledger", () => {
    it("records successful calls", async () => {
      const api = fakeApi(() =>
        jsonResponse(validBody(), 200, { "x-typesafe-request-id": "req_1" }),
      );
      const ledger = createMemoryLedger();
      await clientWith(api.fetch, { ledger }).ask(request);

      expect(ledger.entries).toEqual([
        {
          at: 1_005,
          purpose: "test",
          model: JEV_MODEL,
          status: "ok",
          inputTokens: 1000,
          outputTokens: 40,
          costNanoUsd: 42_000,
          latencyMs: 5,
          requestId: "req_1",
        },
      ]);
      expect(ledger.totalCostNanoUsd()).toBe(42_000);
    });

    it("records failed calls at zero cost", async () => {
      const api = fakeApi(() => jsonResponse({}, 429));
      const ledger = createMemoryLedger();
      await expect(clientWith(api.fetch, { ledger }).ask(request)).rejects.toBeInstanceOf(JevError);

      expect(ledger.entries).toHaveLength(1);
      expect(ledger.entries[0]).toMatchObject({
        status: "error",
        errorCode: "RATE_LIMITED",
        costNanoUsd: 0,
      });
    });

    it("keeps the original error when the ledger fails while recording a failure", async () => {
      const api = fakeApi(() => jsonResponse({}, 401));
      const ledger = { record: () => Promise.reject(new Error("disk full")) };
      await expect(clientWith(api.fetch, { ledger }).ask(request)).rejects.toMatchObject({
        code: "AUTHENTICATION",
      });
    });
  });

  it("holds a rate limiter slot for the duration of the call", async () => {
    let held = 0;
    let released = 0;
    const rateLimiter: RateLimiter = {
      acquire: () => {
        held += 1;
        return Promise.resolve(() => {
          released += 1;
        });
      },
    };
    const ok = fakeApi(() => jsonResponse(validBody()));
    await clientWith(ok.fetch, { rateLimiter }).ask(request);
    const failing = fakeApi(() => jsonResponse({}, 500));
    await clientWith(failing.fetch, { rateLimiter })
      .ask(request)
      .catch(() => undefined);

    expect({ held, released }).toEqual({ held: 2, released: 2 });
  });
});
