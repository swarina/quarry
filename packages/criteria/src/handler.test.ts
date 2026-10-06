import { createJevClient, createSpendLimit, type JevClient, JevError } from "@quarry/jev";
import { describe, expect, it } from "vitest";
import { createMemoryBudgetStore } from "./budget.ts";
import { createCriteriaHandler } from "./handler.ts";
import { createMemoryAnswerCache, createMemoryPostingSource, type PostingText } from "./ports.ts";

const SECRET = "a-long-enough-shared-secret";
const MODEL = "jev-1.13.0";
const CENT = 10_000_000;

function posting(id: string, overrides: Partial<PostingText> = {}): PostingText {
  return {
    id: id.padEnd(16, "0"),
    contentHash: `hash-${id}`,
    title: `Engineer ${id}`,
    company: "Acme",
    locations: ["Berlin"],
    description: "Build and run the platform.",
    ...overrides,
  };
}

function stubClient(costNanoUsd = 4_200): JevClient & { readonly calls: () => number } {
  let calls = 0;
  return {
    model: MODEL,
    async ask(request) {
      calls += 1;
      return {
        model: MODEL,
        answers: Object.fromEntries(
          Object.keys(request.questions).map((id) => [id, { type: "noul", noul: 0.8 }]),
        ) as never,
        usage: { inputTokens: 100, outputTokens: 0, costNanoUsd },
        requestId: undefined,
        latencyMs: 1,
      };
    },
    calls: () => calls,
  };
}

function handlerFor(
  overrides: Partial<Parameters<typeof createCriteriaHandler>[0]> = {},
  postings: readonly PostingText[] = [posting("aaa"), posting("bbb")],
) {
  return createCriteriaHandler({
    secret: SECRET,
    postings: createMemoryPostingSource(postings),
    cache: createMemoryAnswerCache(),
    budget: createMemoryBudgetStore(),
    limits: { perRequestNanoUsd: CENT, perDayNanoUsd: 10 * CENT },
    client: () => stubClient(),
    ...overrides,
  });
}

const CRITERION = { kind: "yes-no", question: "Is the on-call heavy?" };

function ask(
  body: unknown,
  options: {
    readonly secret?: string | null;
    readonly path?: string;
    readonly method?: string;
  } = {},
): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const secret = options.secret === undefined ? SECRET : options.secret;
  if (secret !== null) headers["authorization"] = `Bearer ${secret}`;
  const method = options.method ?? "POST";
  return new Request(`https://quarry.example${options.path ?? "/criteria/ask"}`, {
    method,
    headers,
    // GET and HEAD cannot carry one, and the route check runs before the body is read anyway.
    ...(method === "GET" || method === "HEAD"
      ? {}
      : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

describe("the way in", () => {
  it("answers a well-formed request", async () => {
    const response = await handlerFor()(ask({ criteria: [CRITERION], postings: ["aaa", "bbb"] }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    // Answers behind a secret must not sit in a shared cache.
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as {
      criteria: { id: string; options: string[] }[];
      answers: { id: string; answers: { distribution: number[] }[] }[];
      report: { asked: number; postings: number };
    };
    expect(body.criteria[0]?.options).toEqual(["no", "yes"]);
    expect(body.report).toMatchObject({ postings: 2, asked: 2 });
    expect(body.answers[0]?.answers[0]?.distribution).toEqual([20, 80]);
  });

  it.each([
    ["no token", null],
    ["the wrong token", "not-the-secret"],
    ["a token that is a prefix of the secret", SECRET.slice(0, 5)],
    ["a token that is the secret plus more", `${SECRET}x`],
    ["an empty token", ""],
  ])("refuses %s", async (_name, secret) => {
    const response = await handlerFor()(
      ask({ criteria: [CRITERION], postings: ["aaa"] }, { secret }),
    );
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("spends nothing when the token is wrong", async () => {
    const client = stubClient();
    await handlerFor({ client: () => client })(
      ask({ criteria: [CRITERION], postings: ["aaa"] }, { secret: "wrong" }),
    );
    expect(client.calls()).toBe(0);
  });

  it("refuses an unknown route and a wrong method", async () => {
    const handler = handlerFor();
    expect((await handler(ask({}, { path: "/elsewhere" }))).status).toBe(404);
    const wrongMethod = await handler(ask({}, { method: "GET" }));
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("POST");
  });
});

describe("what a bad request is told", () => {
  it.each([
    ["body that is not JSON", "{oops", /not JSON/],
    ["no criteria", { postings: ["aaa"] }, /not a list/],
    ["no postings", { criteria: [CRITERION] }, /postings is not a list/],
    ["an empty posting list", { criteria: [CRITERION], postings: [] }, /no postings/],
    [
      "a posting that is not an id",
      { criteria: [CRITERION], postings: [7] },
      /postings\[0\] is not a posting id/,
    ],
    [
      "a criterion of an unknown kind",
      { criteria: [{ kind: "essay", question: "why?" }], postings: ["aaa"] },
      /kind is not one of/,
    ],
    [
      "an empty question",
      { criteria: [{ kind: "yes-no", question: "" }], postings: ["aaa"] },
      /question is empty/,
    ],
  ])("says what is wrong with %s", async (_name, body, message) => {
    const response = await handlerFor()(ask(body));
    expect(response.status).toBe(400);
    const parsed = (await response.json()) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe("BAD_REQUEST");
    expect(parsed.error.message).toMatch(message);
  });

  it("refuses more postings than it will answer about, pointing at filtering", async () => {
    const many = Array.from({ length: 501 }, (_value, at) => `p${at}`);
    const response = await handlerFor()(ask({ criteria: [CRITERION], postings: many }));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/at most 500 postings/);
  });

  it("refuses more criteria than it allows", async () => {
    const many = Array.from({ length: 6 }, (_value, at) => ({
      kind: "yes-no",
      question: `question ${at}?`,
    }));
    const response = await handlerFor()(ask({ criteria: many, postings: ["aaa"] }));
    expect(response.status).toBe(400);
  });

  it("spends nothing on a bad request", async () => {
    const client = stubClient();
    await handlerFor({ client: () => client })(ask({ criteria: [], postings: ["aaa"] }));
    expect(client.calls()).toBe(0);
  });
});

describe("the estimate", () => {
  it("prices the request without spending, and says what is already cached", async () => {
    const handler = handlerFor();
    const response = await handler(
      ask({ criteria: [CRITERION], postings: ["aaa", "bbb"] }, { path: "/criteria/estimate" }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      estimate: { postings: number; toAsk: number; nanoUsd: number; cached: number };
      limits: { committedTodayNanoUsd: number };
    };
    expect(body.estimate).toMatchObject({ postings: 2, toAsk: 2, cached: 0 });
    expect(body.estimate.nanoUsd).toBeGreaterThan(0);
    // Estimating must not consume the day's budget.
    expect(body.limits.committedTodayNanoUsd).toBe(0);
  });

  it("asks nothing, so it cannot cost anything", async () => {
    const client = stubClient();
    await handlerFor({ client: () => client })(
      ask({ criteria: [CRITERION], postings: ["aaa"] }, { path: "/criteria/estimate" }),
    );
    expect(client.calls()).toBe(0);
  });

  it("prices a second ask at nothing once the answers are cached", async () => {
    const shared = {
      cache: createMemoryAnswerCache(),
      budget: createMemoryBudgetStore(),
    };
    const handler = handlerFor(shared);
    await handler(ask({ criteria: [CRITERION], postings: ["aaa"] }));
    const response = await handler(
      ask({ criteria: [CRITERION], postings: ["aaa"] }, { path: "/criteria/estimate" }),
    );
    const body = (await response.json()) as { estimate: { toAsk: number; nanoUsd: number } };
    expect(body.estimate).toMatchObject({ toAsk: 0, nanoUsd: 0 });
  });
});

describe("the daily budget", () => {
  it("refuses once the day is spent, and says when it resets", async () => {
    const budget = createMemoryBudgetStore();
    const handler = handlerFor({
      budget,
      // One request's worth for the whole day.
      limits: { perRequestNanoUsd: CENT, perDayNanoUsd: CENT },
      client: (allowance) => {
        expect(allowance).toBeGreaterThan(0);
        // Spends the whole allowance, so nothing is left for a second request.
        return stubClient(allowance);
      },
    });
    const first = await handler(ask({ criteria: [CRITERION], postings: ["aaa"] }));
    expect(first.status).toBe(200);

    const second = await handler(ask({ criteria: [CRITERION], postings: ["bbb"] }));
    expect(second.status).toBe(429);
    const body = (await second.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("BUDGET_SPENT");
    expect(body.error.message).toMatch(/midnight UTC/);
  });

  it("gives back what a request did not spend", async () => {
    const budget = createMemoryBudgetStore();
    const handler = handlerFor({
      budget,
      limits: { perRequestNanoUsd: CENT, perDayNanoUsd: 2 * CENT },
      client: () => stubClient(1_000),
    });
    await handler(ask({ criteria: [CRITERION], postings: ["aaa"] }));
    // One request costing 1,000 must leave nearly the whole day, not a whole allowance less.
    expect(await budget.committed(new Date().toISOString().slice(0, 10))).toBe(1_000);
  });

  it("gives the reservation back when a request throws", async () => {
    const budget = createMemoryBudgetStore();
    const handler = handlerFor({
      budget,
      client: () => ({
        model: MODEL,
        ask: () => Promise.reject(new Error("the source fell over")),
      }),
      postings: createMemoryPostingSource([posting("aaa")]),
    });
    // A failure inside the ask loop is counted, not thrown, so this one comes from the source.
    const broken = createCriteriaHandler({
      secret: SECRET,
      postings: {
        read: () => Promise.reject(new Error("the source fell over")),
      },
      cache: createMemoryAnswerCache(),
      budget,
      limits: { perRequestNanoUsd: CENT, perDayNanoUsd: 10 * CENT },
      client: () => stubClient(),
    });
    await expect(broken(ask({ criteria: [CRITERION], postings: ["aaa"] }))).rejects.toThrow(
      /fell over/,
    );
    expect(await budget.committed(new Date().toISOString().slice(0, 10))).toBe(0);
    expect(handler).toBeDefined();
  });

  it("says when the allowance was shortened by the day rather than the request cap", async () => {
    const budget = createMemoryBudgetStore();
    const limits = { perRequestNanoUsd: CENT, perDayNanoUsd: CENT + 500 };
    const handler = handlerFor({ budget, limits, client: () => stubClient(CENT) });
    await handler(ask({ criteria: [CRITERION], postings: ["aaa"] }));
    const second = await handler(ask({ criteria: [CRITERION], postings: ["bbb"] }));
    const body = (await second.json()) as {
      budget: { allowanceNanoUsd: number; limitedByDay: boolean };
    };
    expect(body.budget.allowanceNanoUsd).toBe(500);
    expect(body.budget.limitedByDay).toBe(true);
  });
});

describe("the allowance is exact, not approximate", () => {
  it("is enforced by the client's spend limit, which refuses past the cap", async () => {
    // The ask loop starts requests from an estimate, so the hard cap has to come from the
    // client. Here the client carries a real spend limit set to the allowance, and a transport
    // that would happily charge far more than it: the limit is what stops it.
    const allowanceSeen: number[] = [];
    const handler = handlerFor(
      {
        limits: { perRequestNanoUsd: 50_000, perDayNanoUsd: 10 * CENT },
        client: (allowanceNanoUsd) => {
          allowanceSeen.push(allowanceNanoUsd);
          return createJevClient({
            apiKey: "test",
            spendLimit: createSpendLimit({ limitNanoUsd: allowanceNanoUsd }),
            maxRetries: 0,
            // Every request claims a huge payload, so the reservation alone exceeds the cap
            // after the first few.
            fetch: () =>
              Promise.resolve(
                new Response(
                  JSON.stringify({
                    model: MODEL,
                    answers: { x: { type: "noul", noul: 0.5 } },
                    usage: { input_tokens: 1_000_000, output_tokens: 0 },
                  }),
                  { status: 200, headers: { "content-type": "application/json" } },
                ),
              ),
          });
        },
      },
      Array.from({ length: 20 }, (_value, at) => posting(`p${at}`)),
    );
    const response = await handler(
      ask({
        criteria: [CRITERION],
        postings: Array.from({ length: 20 }, (_value, at) => `p${at}`),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      report: { costNanoUsd: number; failed: number; stoppedBy: string };
    };
    expect(allowanceSeen).toEqual([50_000]);
    // Whatever the loop tried, nothing got past the cap.
    expect(body.report.costNanoUsd).toBeLessThanOrEqual(50_000);
    expect(body.report.stoppedBy).toBe("budget");
  });
});

describe("a partial answer is never passed off as a whole one", () => {
  it("reports what it did not reach when the deadline passes", async () => {
    const postings = Array.from({ length: 10 }, (_value, at) => posting(`p${at}`));
    let clock = Date.now();
    const handler = handlerFor(
      {
        timeoutMs: 10,
        now: () => {
          clock += 4;
          return clock;
        },
      },
      postings,
    );
    const response = await handler(
      ask({
        criteria: [CRITERION],
        postings: postings.map((entry) => entry.id),
      }),
    );
    const body = (await response.json()) as {
      report: { stoppedBy: string; outstanding: number; asked: number };
    };
    expect(body.report.stoppedBy).toBe("deadline");
    expect(body.report.outstanding).toBeGreaterThan(0);
    expect(body.report.asked).toBeLessThan(10);
  });

  it("reports a posting it could not resolve rather than inventing one", async () => {
    const response = await handlerFor()(
      ask({ criteria: [CRITERION], postings: ["aaa", "nonexistent"] }),
    );
    const body = (await response.json()) as { report: { postings: number } };
    expect(body.report.postings).toBe(1);
  });

  it("counts a Jev failure without failing the request", async () => {
    const handler = handlerFor({
      client: () => ({
        model: MODEL,
        ask: () => Promise.reject(new JevError("OVERLOADED", "busy")),
      }),
    });
    const response = await handler(ask({ criteria: [CRITERION], postings: ["aaa", "bbb"] }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      report: { failed: number; outstanding: number; errors: string[] };
    };
    expect(body.report.failed).toBeGreaterThan(0);
    expect(body.report.outstanding).toBe(2);
    expect(body.report.errors[0]).toMatch(/OVERLOADED/);
  });
});
