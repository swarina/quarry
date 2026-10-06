import { type JevClient, JevError } from "@quarry/jev";
import { describe, expect, it } from "vitest";
import { askCriteria, estimateAsk } from "./ask.ts";
import { type Criterion, readCriteria, readCriterion } from "./criterion.ts";
import {
  type AnswerCache,
  createMemoryAnswerCache,
  createMemoryPostingSource,
  type PostingText,
} from "./ports.ts";

const MODEL = "jev-1.13.0";
const DEADLINE = Number.POSITIVE_INFINITY;
/** Generous, so a test only hits the budget when it means to. */
const PLENTY = 1_000_000_000;

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

/** A client that answers every question yes with the given probability, and counts requests. */
function stubClient(
  options: {
    readonly yes?: number;
    readonly failTimes?: number;
    readonly failWith?: unknown;
    readonly costNanoUsd?: number;
  } = {},
): JevClient & { readonly calls: () => number; readonly questionsSeen: () => string[][] } {
  let calls = 0;
  let failures = 0;
  const questionsSeen: string[][] = [];
  return {
    model: MODEL,
    async ask(request) {
      calls += 1;
      const ids = Object.keys(request.questions);
      questionsSeen.push(ids);
      if (options.failTimes !== undefined && failures < options.failTimes) {
        failures += 1;
        throw options.failWith ?? new JevError("SERVER", "nope");
      }
      const yes = options.yes ?? 0.8;
      return {
        model: MODEL,
        answers: Object.fromEntries(ids.map((id) => [id, { type: "noul", noul: yes }])) as never,
        usage: {
          inputTokens: 100,
          outputTokens: 0,
          costNanoUsd: options.costNanoUsd ?? 4_200,
        },
        requestId: undefined,
        latencyMs: 1,
      };
    },
    calls: () => calls,
    questionsSeen: () => questionsSeen,
  };
}

async function oneCriterion(question = "Is the on-call heavy?"): Promise<Criterion> {
  return readCriterion({ kind: "yes-no", question });
}

describe("asking criteria of the postings a search left", () => {
  it("asks once per posting, with every missing criterion in that one request", async () => {
    const criteria = await readCriteria(
      [
        { kind: "yes-no", question: "Is the on-call heavy?" },
        { kind: "yes-no", question: "Do they sponsor visas?" },
      ],
      5,
    );
    const client = stubClient();
    const result = await askCriteria({
      criteria,
      idPrefixes: ["aaa", "bbb"],
      postings: createMemoryPostingSource([posting("aaa"), posting("bbb")]),
      cache: createMemoryAnswerCache(),
      client,
      allowanceNanoUsd: PLENTY,
      deadline: DEADLINE,
      concurrency: 1,
    });
    // Two postings, two criteria, two requests: the text is what costs, so questions are packed.
    expect(client.calls()).toBe(2);
    expect(client.questionsSeen()[0]).toHaveLength(2);
    expect(result.report).toMatchObject({ postings: 2, wanted: 4, cached: 0, asked: 2, failed: 0 });
    expect(result.report.stoppedBy).toBe("finished");
    expect(result.report.outstanding).toBe(0);
  });

  it("returns an answer per criterion, as a distribution the site can read", async () => {
    const criteria = [await oneCriterion()];
    const result = await askCriteria({
      criteria,
      idPrefixes: ["aaa"],
      postings: createMemoryPostingSource([posting("aaa")]),
      cache: createMemoryAnswerCache(),
      client: stubClient({ yes: 0.75 }),
      allowanceNanoUsd: PLENTY,
      deadline: DEADLINE,
      concurrency: 1,
    });
    expect(result.answers[0]?.answers[0]).toEqual({
      criterionId: criteria[0]?.id,
      // A yes/no answer is two options, no first: 25 then 75.
      distribution: [25, 75],
      cached: false,
    });
  });
});

describe("the cache", () => {
  it("makes the same question about the same text free the second time", async () => {
    const criteria = [await oneCriterion()];
    const cache = createMemoryAnswerCache();
    const source = createMemoryPostingSource([posting("aaa")]);
    const first = stubClient();
    await askCriteria({
      criteria,
      idPrefixes: ["aaa"],
      postings: source,
      cache,
      client: first,
      allowanceNanoUsd: PLENTY,
      deadline: DEADLINE,
      concurrency: 1,
    });
    expect(first.calls()).toBe(1);

    const second = stubClient();
    const again = await askCriteria({
      criteria,
      idPrefixes: ["aaa"],
      postings: source,
      cache,
      client: second,
      allowanceNanoUsd: PLENTY,
      deadline: DEADLINE,
      concurrency: 1,
    });
    expect(second.calls()).toBe(0);
    expect(again.report).toMatchObject({ cached: 1, asked: 0, costNanoUsd: 0 });
    expect(again.answers[0]?.answers[0]?.cached).toBe(true);
  });

  it("asks only the criteria a posting is missing", async () => {
    const [known, fresh] = await readCriteria(
      [
        { kind: "yes-no", question: "Is the on-call heavy?" },
        { kind: "yes-no", question: "Do they sponsor visas?" },
      ],
      5,
    );
    if (known === undefined || fresh === undefined) throw new Error("two criteria expected");
    const cache = createMemoryAnswerCache();
    const source = createMemoryPostingSource([posting("aaa")]);
    await askCriteria({
      criteria: [known],
      idPrefixes: ["aaa"],
      postings: source,
      cache,
      client: stubClient(),
      allowanceNanoUsd: PLENTY,
      deadline: DEADLINE,
      concurrency: 1,
    });

    const client = stubClient();
    await askCriteria({
      criteria: [known, fresh],
      idPrefixes: ["aaa"],
      postings: source,
      cache,
      client,
      allowanceNanoUsd: PLENTY,
      deadline: DEADLINE,
      concurrency: 1,
    });
    expect(client.questionsSeen()).toEqual([[fresh.id]]);
  });

  it("asks again when the posting's text changed, since the key is the content", async () => {
    const criteria = [await oneCriterion()];
    const cache = createMemoryAnswerCache();
    await askCriteria({
      criteria,
      idPrefixes: ["aaa"],
      postings: createMemoryPostingSource([posting("aaa")]),
      cache,
      client: stubClient(),
      allowanceNanoUsd: PLENTY,
      deadline: DEADLINE,
      concurrency: 1,
    });
    const client = stubClient();
    await askCriteria({
      criteria,
      idPrefixes: ["aaa"],
      postings: createMemoryPostingSource([
        posting("aaa", { contentHash: "hash-aaa-edited", description: "Rewritten." }),
      ]),
      cache,
      client,
      allowanceNanoUsd: PLENTY,
      deadline: DEADLINE,
      concurrency: 1,
    });
    expect(client.calls()).toBe(1);
  });

  it("shares one answer between two postings whose text is identical", async () => {
    const criteria = [await oneCriterion()];
    const client = stubClient();
    // A repost: a different posting id, the same content hash.
    const result = await askCriteria({
      criteria,
      idPrefixes: ["aaa", "bbb"],
      postings: createMemoryPostingSource([
        posting("aaa", { contentHash: "same" }),
        posting("bbb", { contentHash: "same" }),
      ]),
      cache: createMemoryAnswerCache(),
      client,
      allowanceNanoUsd: PLENTY,
      deadline: DEADLINE,
      concurrency: 1,
    });
    // One request, and both postings get an answer.
    expect(client.calls()).toBe(1);
    expect(result.answers.every((entry) => entry.answers.length === 1)).toBe(true);
  });

  it("treats an answer it cannot read as missing, not as a wrong answer", async () => {
    const criteria = [await oneCriterion()];
    const broken: AnswerCache = {
      read: (_id, _model, hashes) =>
        Promise.resolve(hashes.map((contentHash) => ({ contentHash, answerJson: "{oops" }))),
      write: () => Promise.resolve(),
    };
    const client = stubClient();
    const result = await askCriteria({
      criteria,
      idPrefixes: ["aaa"],
      postings: createMemoryPostingSource([posting("aaa")]),
      cache: broken,
      client,
      allowanceNanoUsd: PLENTY,
      deadline: DEADLINE,
      concurrency: 1,
    });
    // It was in the cache, so nothing was asked, and it is reported outstanding rather than
    // served as an answer.
    expect(client.calls()).toBe(0);
    expect(result.answers[0]?.answers).toEqual([]);
    expect(result.report.outstanding).toBe(1);
  });
});

describe("the budget", () => {
  it("stops once the allowance is reached, and reports what it did not reach", async () => {
    const criteria = [await oneCriterion()];
    const postings = Array.from({ length: 10 }, (_value, at) => posting(`p${at}`));
    const perCall = 10_000;
    const allowance = 35_000;
    const result = await askCriteria({
      criteria,
      idPrefixes: postings.map((entry) => entry.id),
      postings: createMemoryPostingSource(postings),
      cache: createMemoryAnswerCache(),
      client: stubClient({ costNanoUsd: perCall }),
      allowanceNanoUsd: allowance,
      deadline: DEADLINE,
      concurrency: 1,
    });
    expect(result.report.stoppedBy).toBe("budget");
    expect(result.report.asked).toBeGreaterThan(0);
    expect(result.report.asked).toBeLessThan(10);
    // The loop learns a request's cost only when it comes back, so it can pass the allowance by
    // at most the requests it had in flight: one here, since concurrency is 1. The exact cap is
    // the client's spend limit, which `createCriteriaHandler` sets to the same allowance; this
    // stub has none, which is why the overshoot is visible at all.
    expect(result.report.costNanoUsd).toBeLessThanOrEqual(allowance + perCall);
    // The postings it did not reach are reported, not silently dropped.
    expect(result.report.outstanding).toBe(10 - result.report.asked);
  });

  it("asks nothing when the allowance is spent", async () => {
    const criteria = [await oneCriterion()];
    const client = stubClient();
    const result = await askCriteria({
      criteria,
      idPrefixes: ["aaa"],
      postings: createMemoryPostingSource([posting("aaa")]),
      cache: createMemoryAnswerCache(),
      client,
      allowanceNanoUsd: 0,
      deadline: DEADLINE,
      concurrency: 1,
    });
    expect(client.calls()).toBe(0);
    expect(result.report.stoppedBy).toBe("budget");
  });

  it("does not let refused spends look like a broken source", async () => {
    // Enough refusals in a row to trip the consecutive-failure stop, if they counted. They
    // must not: postings refused for lack of money are not evidence that anything is broken,
    // and reporting "errors" would send a reader looking for a fault that is not there.
    const criteria = [await oneCriterion()];
    const postings = Array.from({ length: 10 }, (_value, at) => posting(`p${at}`));
    const result = await askCriteria({
      criteria,
      idPrefixes: postings.map((entry) => entry.id),
      postings: createMemoryPostingSource(postings),
      cache: createMemoryAnswerCache(),
      client: stubClient({
        failTimes: 50,
        failWith: new JevError("BUDGET_EXCEEDED", "over the cap"),
      }),
      allowanceNanoUsd: PLENTY,
      deadline: DEADLINE,
      concurrency: 1,
    });
    expect(result.report.stoppedBy).toBe("budget");
    expect(result.report.failed).toBe(0);
    expect(result.report.errors).toEqual([]);
    // Nothing was answered, and the run says so rather than claiming to have finished.
    expect(result.report.outstanding).toBe(10);
  });

  it("reports the budget rather than a run of failures when both happened", async () => {
    // Failures first, then a refused spend: the budget is the binding constraint and the one a
    // reader can act on, so it wins however the workers happened to finish.
    const criteria = [await oneCriterion()];
    const postings = Array.from({ length: 8 }, (_value, at) => posting(`p${at}`));
    let calls = 0;
    const client: JevClient = {
      model: MODEL,
      ask: () => {
        calls += 1;
        return Promise.reject(
          calls <= 2
            ? new JevError("OVERLOADED", "busy")
            : new JevError("BUDGET_EXCEEDED", "over the cap"),
        );
      },
    };
    const result = await askCriteria({
      criteria,
      idPrefixes: postings.map((entry) => entry.id),
      postings: createMemoryPostingSource(postings),
      cache: createMemoryAnswerCache(),
      client,
      allowanceNanoUsd: PLENTY,
      deadline: DEADLINE,
      concurrency: 1,
    });
    expect(result.report.failed).toBe(2);
    expect(result.report.stoppedBy).toBe("budget");
  });

  it("reads a refused spend as the budget speaking, not as a bad posting", async () => {
    const criteria = [await oneCriterion()];
    const result = await askCriteria({
      criteria,
      idPrefixes: ["aaa", "bbb"],
      postings: createMemoryPostingSource([posting("aaa"), posting("bbb")]),
      cache: createMemoryAnswerCache(),
      client: stubClient({
        failTimes: 1,
        failWith: new JevError("BUDGET_EXCEEDED", "over the cap"),
      }),
      allowanceNanoUsd: PLENTY,
      deadline: DEADLINE,
      concurrency: 1,
    });
    expect(result.report.stoppedBy).toBe("budget");
  });

  it("stops at the deadline", async () => {
    const criteria = [await oneCriterion()];
    const postings = Array.from({ length: 5 }, (_value, at) => posting(`p${at}`));
    let clock = 0;
    const result = await askCriteria({
      criteria,
      idPrefixes: postings.map((entry) => entry.id),
      postings: createMemoryPostingSource(postings),
      cache: createMemoryAnswerCache(),
      client: stubClient(),
      allowanceNanoUsd: PLENTY,
      deadline: 10,
      concurrency: 1,
      now: () => {
        clock += 4;
        return clock;
      },
    });
    expect(result.report.stoppedBy).toBe("deadline");
    expect(result.report.asked).toBeLessThan(5);
  });
});

describe("failures", () => {
  it("carries on past an isolated failure", async () => {
    const criteria = [await oneCriterion()];
    const postings = Array.from({ length: 4 }, (_value, at) => posting(`p${at}`));
    const result = await askCriteria({
      criteria,
      idPrefixes: postings.map((entry) => entry.id),
      postings: createMemoryPostingSource(postings),
      cache: createMemoryAnswerCache(),
      client: stubClient({ failTimes: 1 }),
      allowanceNanoUsd: PLENTY,
      deadline: DEADLINE,
      concurrency: 1,
    });
    expect(result.report.failed).toBe(1);
    expect(result.report.asked).toBe(4);
    expect(result.report.stoppedBy).toBe("finished");
    expect(result.report.errors).toHaveLength(1);
  });

  it("gives up after a run of failures, which say the problem is not this posting", async () => {
    const criteria = [await oneCriterion()];
    const postings = Array.from({ length: 20 }, (_value, at) => posting(`p${at}`));
    const result = await askCriteria({
      criteria,
      idPrefixes: postings.map((entry) => entry.id),
      postings: createMemoryPostingSource(postings),
      cache: createMemoryAnswerCache(),
      client: stubClient({ failTimes: 50 }),
      allowanceNanoUsd: PLENTY,
      deadline: DEADLINE,
      concurrency: 1,
    });
    expect(result.report.stoppedBy).toBe("errors");
    expect(result.report.asked).toBe(5);
  });
});

describe("naming postings", () => {
  it("resolves the id prefixes the search index carries", async () => {
    const criteria = [await oneCriterion()];
    const full = posting("abcdefghij");
    const result = await askCriteria({
      criteria,
      idPrefixes: [full.id.slice(0, 10)],
      postings: createMemoryPostingSource([full]),
      cache: createMemoryAnswerCache(),
      client: stubClient(),
      allowanceNanoUsd: PLENTY,
      deadline: DEADLINE,
      concurrency: 1,
    });
    expect(result.answers[0]?.id).toBe(full.id);
  });

  it("leaves out an ambiguous prefix rather than answering about the wrong job", async () => {
    const criteria = [await oneCriterion()];
    const result = await askCriteria({
      criteria,
      idPrefixes: ["aa"],
      postings: createMemoryPostingSource([posting("aab"), posting("aac")]),
      cache: createMemoryAnswerCache(),
      client: stubClient(),
      allowanceNanoUsd: PLENTY,
      deadline: DEADLINE,
      concurrency: 1,
    });
    expect(result.report.postings).toBe(0);
  });

  it("leaves out a prefix that matches nothing", async () => {
    const criteria = [await oneCriterion()];
    const result = await askCriteria({
      criteria,
      idPrefixes: ["zzz"],
      postings: createMemoryPostingSource([posting("aaa")]),
      cache: createMemoryAnswerCache(),
      client: stubClient(),
      allowanceNanoUsd: PLENTY,
      deadline: DEADLINE,
      concurrency: 1,
    });
    expect(result.report.postings).toBe(0);
  });
});

describe("estimating before spending", () => {
  it("counts what is cached as free and prices only the rest", async () => {
    const criteria = [await oneCriterion()];
    const cache = createMemoryAnswerCache();
    const source = createMemoryPostingSource([posting("aaa"), posting("bbb")]);
    const before = await estimateAsk({
      criteria,
      idPrefixes: ["aaa", "bbb"],
      postings: source,
      cache,
      model: MODEL,
    });
    expect(before).toMatchObject({ postings: 2, wanted: 2, cached: 0, toAsk: 2 });
    expect(before.nanoUsd).toBeGreaterThan(0);

    await askCriteria({
      criteria,
      idPrefixes: ["aaa"],
      postings: source,
      cache,
      client: stubClient(),
      allowanceNanoUsd: PLENTY,
      deadline: DEADLINE,
      concurrency: 1,
    });
    const after = await estimateAsk({
      criteria,
      idPrefixes: ["aaa", "bbb"],
      postings: source,
      cache,
      model: MODEL,
    });
    expect(after).toMatchObject({ cached: 1, toAsk: 1 });
    expect(after.nanoUsd).toBeLessThan(before.nanoUsd);
  });

  it("costs nothing when everything is cached", async () => {
    const criteria = [await oneCriterion()];
    const cache = createMemoryAnswerCache();
    const source = createMemoryPostingSource([posting("aaa")]);
    await askCriteria({
      criteria,
      idPrefixes: ["aaa"],
      postings: source,
      cache,
      client: stubClient(),
      allowanceNanoUsd: PLENTY,
      deadline: DEADLINE,
      concurrency: 1,
    });
    const estimate = await estimateAsk({
      criteria,
      idPrefixes: ["aaa"],
      postings: source,
      cache,
      model: MODEL,
    });
    expect(estimate).toMatchObject({ toAsk: 0, nanoUsd: 0 });
  });

  it("prices a longer description higher, since the text is what costs", async () => {
    const criteria = [await oneCriterion()];
    const short = await estimateAsk({
      criteria,
      idPrefixes: ["aaa"],
      postings: createMemoryPostingSource([posting("aaa", { description: "Short." })]),
      cache: createMemoryAnswerCache(),
      model: MODEL,
    });
    const long = await estimateAsk({
      criteria,
      idPrefixes: ["aaa"],
      postings: createMemoryPostingSource([posting("aaa", { description: "Long. ".repeat(500) })]),
      cache: createMemoryAnswerCache(),
      model: MODEL,
    });
    expect(long.nanoUsd).toBeGreaterThan(short.nanoUsd);
  });
});
