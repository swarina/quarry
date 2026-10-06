/**
 * These tests exist because `criteria.ts` declares the wire shapes a second time, rather than
 * importing them from `@quarry/criteria` and dragging the SDK into the bundle. A second
 * declaration can drift from the one the server enforces, and the drift would show up as a
 * person's first click failing. So the page's own requests are driven against a real handler
 * here, where a mismatch is a failing test instead.
 */
import {
  createCriteriaHandler,
  createMemoryAnswerCache,
  createMemoryBudgetStore,
  createMemoryPostingSource,
  MAX_CRITERIA,
  MAX_POSTINGS,
  readCriterion,
} from "@quarry/criteria";
import { beforeEach, describe, expect, it } from "vitest";
import { lock, unlock } from "./credentials.ts";
import {
  ask,
  CriteriaRequestError,
  type CriterionDraft,
  draftOptions,
  draftProblem,
  estimate,
  MAX_CRITERIA as SITE_MAX_CRITERIA,
  MAX_POSTINGS as SITE_MAX_POSTINGS,
  stoppedBecause,
  usd,
} from "./criteria.ts";

const SECRET = "a-secret-of-at-least-24-chars";

/**
 * A client that answers every question with the same flat distribution, spending a little.
 *
 * Its type is taken from the handler's own option rather than imported from `@quarry/jev`,
 * because the site does not depend on that package and must not start to: the reason these wire
 * shapes are declared by hand is to keep the SDK out of the bundle.
 */
type ClientFactory = Parameters<typeof createCriteriaHandler>[0]["client"];

const flatClient: ClientFactory = () =>
  ({
    ask: async (request: { readonly questions: Record<string, unknown> }) => {
      const answers: Record<string, unknown> = {};
      for (const name of Object.keys(request.questions)) {
        answers[name] = { type: "noul", noul: 0.5 };
      }
      return { answers, usage: { costNanoUsd: 1000 } };
    },
  }) as unknown as ReturnType<ClientFactory>;

function handlerOver(postings: readonly { id: string; title: string; description: string }[]) {
  return createCriteriaHandler({
    secret: SECRET,
    model: "jev-1.13.0",
    postings: createMemoryPostingSource(
      postings.map((posting) => ({
        id: posting.id,
        company: "Example",
        contentHash: `hash-${posting.id}`,
        title: posting.title,
        description: posting.description,
        locations: ["Berlin, Germany"],
      })),
    ),
    cache: createMemoryAnswerCache(),
    budget: createMemoryBudgetStore(),
    limits: { perRequestNanoUsd: 1_000_000, perDayNanoUsd: 10_000_000 },
    client: flatClient,
  });
}

/** Sends the page's requests straight into a handler, with no network in between. */
function sendTo(handler: (request: Request) => Promise<Response>, secret = SECRET) {
  return async (path: string, init: RequestInit): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (secret !== SECRET) headers.set("authorization", `Bearer ${secret}`);
    return await handler(new Request(`https://quarry.test${path}`, { ...init, headers }));
  };
}

beforeEach(() => {
  lock();
  unlock(SECRET);
});

describe("the limits the page believes in", () => {
  it("are the ones the handler enforces", () => {
    // The page disables asking rather than sending something that would be refused, which only
    // works while it knows where the refusal starts.
    expect(SITE_MAX_POSTINGS).toBe(MAX_POSTINGS);
    expect(SITE_MAX_CRITERIA).toBe(MAX_CRITERIA);
  });
});

describe("draftOptions", () => {
  const cases: readonly { draft: CriterionDraft; what: string }[] = [
    { what: "yes-no", draft: { kind: "yes-no", question: "Is this remote?", choices: [] } },
    {
      what: "choice",
      draft: { kind: "choice", question: "Which stack?", choices: ["Go", "Rust", "TypeScript"] },
    },
    {
      what: "scale",
      draft: { kind: "scale", question: "How senior?", choices: ["junior", "mid", "senior"] },
    },
  ];

  for (const { draft, what } of cases) {
    it(`agrees with readCriterion for a ${what} question`, async () => {
      // `readCriterion` is the authority on what an answer's probabilities are indexed by. If
      // these disagree, the page labels a probability with the wrong option, which reads as a
      // bad model rather than a bad join.
      const built = await readCriterion(
        draft.kind === "yes-no"
          ? { kind: "yes-no", question: draft.question }
          : draft.kind === "choice"
            ? {
                kind: "choice",
                question: draft.question,
                options: draft.choices.map((label) => ({ label })),
              }
            : { kind: "scale", question: draft.question, levels: draft.choices },
      );
      expect(draftOptions(draft).map((option) => option.id)).toEqual([...built.options]);
      expect(draftOptions(draft).map((option) => option.label)).toEqual([...built.labels]);
    });
  }
});

describe("draftProblem", () => {
  it("passes a complete question", () => {
    expect(draftProblem({ kind: "yes-no", question: "On call?", choices: [] })).toBeUndefined();
  });

  it("catches what the server would refuse, before anything is sent", async () => {
    const tooFew: CriterionDraft = { kind: "choice", question: "Which?", choices: ["only one"] };
    expect(draftProblem(tooFew)).toBeDefined();
    // The same input really is refused, so the message is not guarding an imaginary rule.
    await expect(
      readCriterion({ kind: "choice", question: "Which?", options: [{ label: "only one" }] }),
    ).rejects.toThrow();
  });

  it("catches two options worded the same, which the server also refuses", async () => {
    expect(
      draftProblem({ kind: "choice", question: "Which?", choices: ["same", "same"] }),
    ).toBeDefined();
    await expect(
      readCriterion({
        kind: "choice",
        question: "Which?",
        options: [{ label: "same" }, { label: "same" }],
      }),
    ).rejects.toThrow();
  });

  it("wants a question before anything else", () => {
    expect(draftProblem({ kind: "yes-no", question: "   ", choices: [] })).toBe(
      "Write a question first.",
    );
  });
});

describe("estimate", () => {
  it("prices what the page would ask, and spends nothing", async () => {
    const handler = handlerOver([
      { id: "a1", title: "Platform engineer", description: "You will be on call one week in six." },
      { id: "b2", title: "Data engineer", description: "No on-call duties." },
    ]);
    const reply = await estimate(
      { kind: "yes-no", question: "Is there an on-call rota?", choices: [] },
      ["a1", "b2"],
      sendTo(handler),
    );
    expect(reply.estimate.postings).toBe(2);
    expect(reply.estimate.toAsk).toBeGreaterThan(0);
    expect(reply.limits.committedTodayNanoUsd).toBe(0);
    expect(reply.criteria[0]?.options).toEqual(["no", "yes"]);
  });
});

describe("ask", () => {
  it("answers the postings it was given, in the shape the page reads", async () => {
    const handler = handlerOver([
      { id: "a1", title: "Platform engineer", description: "On call one week in six." },
    ]);
    const reply = await ask(
      { kind: "yes-no", question: "Is there an on-call rota?", choices: [] },
      ["a1"],
      sendTo(handler),
    );
    expect(reply.answers).toHaveLength(1);
    expect(reply.answers[0]?.id).toBe("a1");
    const answer = reply.answers[0]?.answers[0];
    expect(answer?.criterionId).toBe(reply.criteria[0]?.id);
    // Two options, probabilities in hundredths, summing to the whole.
    expect(answer?.distribution).toHaveLength(2);
    expect((answer?.distribution ?? []).reduce((total, value) => total + value, 0)).toBe(100);
    expect(reply.report.stoppedBy).toBe("finished");
  });

  it("reports a wrong secret as a refusal the page can name", async () => {
    const handler = handlerOver([{ id: "a1", title: "T", description: "D" }]);
    await expect(
      ask(
        { kind: "yes-no", question: "On call?", choices: [] },
        ["a1"],
        sendTo(handler, "a-different-secret-of-24-chars"),
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });
  });

  it("carries the server's own words for a refusal, rather than inventing any", async () => {
    const handler = handlerOver([{ id: "a1", title: "T", description: "D" }]);
    const tooMany = Array.from({ length: MAX_POSTINGS + 1 }, (_value, at) => `p${at}`);
    await expect(
      ask({ kind: "yes-no", question: "On call?", choices: [] }, tooMany, sendTo(handler)),
    ).rejects.toThrow(/filter further/);
  });

  it("turns an unreachable server into a refusal rather than an unhandled failure", async () => {
    const dead = () => Promise.reject(new Error("connection refused"));
    await expect(
      ask({ kind: "yes-no", question: "On call?", choices: [] }, ["a1"], dead),
    ).rejects.toBeInstanceOf(CriteriaRequestError);
    await expect(
      ask({ kind: "yes-no", question: "On call?", choices: [] }, ["a1"], dead),
    ).rejects.toMatchObject({ code: "UNREACHABLE" });
  });

  it("refuses to send anything at all without a secret", async () => {
    lock();
    const handler = handlerOver([{ id: "a1", title: "T", description: "D" }]);
    let reached = false;
    const watched = (path: string, init: RequestInit) => {
      reached = true;
      return sendTo(handler)(path, init);
    };
    await expect(
      ask({ kind: "yes-no", question: "On call?", choices: [] }, ["a1"], watched),
    ).rejects.toThrow();
    expect(reached).toBe(false);
  });
});

describe("usd", () => {
  it("says what a reader will actually be charged", () => {
    expect(usd(0)).toBe("nothing");
    // Anything under a cent is reported as such rather than as $0.00, which reads as free.
    expect(usd(5_000_000)).toBe("under $0.01");
    expect(usd(40_000_000)).toBe("$0.04");
    expect(usd(3_030_000_000)).toBe("$3.03");
  });
});

describe("stoppedBecause", () => {
  const report = {
    postings: 10,
    texts: 10,
    wanted: 10,
    cached: 0,
    asked: 4,
    failed: 0,
    costNanoUsd: 100,
    outstanding: 6,
    errors: [],
  };

  it("says nothing about a run that finished", () => {
    expect(
      stoppedBecause({
        criteria: [],
        answers: [],
        report: { ...report, stoppedBy: "finished", outstanding: 0 },
      }),
    ).toBeUndefined();
  });

  it("names the budget, and what to do next", () => {
    const said = stoppedBecause({
      criteria: [],
      answers: [],
      report: { ...report, stoppedBy: "budget" },
    });
    // A partial answer read as a complete one is the mistake the stop reason exists to prevent.
    expect(said).toMatch(/spending limit/);
    expect(said).toMatch(/6 of 10/);
  });

  it("distinguishes running out of time from running out of money", () => {
    const said = stoppedBecause({
      criteria: [],
      answers: [],
      report: { ...report, stoppedBy: "deadline" },
    });
    expect(said).toMatch(/time/);
    expect(said).not.toMatch(/spending limit/);
  });
});
