import { describe, expect, it } from "vitest";
import { buildIndex, type IndexBuild, type IndexRow } from "./build.ts";
import { DEFAULT_ANSWER_THRESHOLD, MAX_SHARD_QUESTIONS, type ShardQuestion } from "./format.ts";
import { type IndexQuery, queryIndex } from "./query.ts";
import { type IndexTable, openIndex } from "./table.ts";

/**
 * The answer columns: what a shard carries, what a threshold means, and what a facet count
 * promises while most of the corpus has not been asked yet.
 */

const DAY = 24 * 60 * 60 * 1000;
const TODAY = 20_100;
const BERLIN = { country: "DE", division: "16", city: 2950159 };

const ARRANGEMENT: ShardQuestion = {
  id: "arrangement",
  version: 1,
  about: "Whether the work is remote, hybrid, or on site",
  kind: "choice",
  options: ["remote", "hybrid", "onsite", "not_stated"],
  labels: ["Remote", "Hybrid", "On site", "Not stated"],
};
const ON_CALL: ShardQuestion = {
  id: "onCall",
  version: 1,
  about: "Whether the role includes an on-call rota",
  kind: "noul",
  options: ["no", "yes"],
  labels: ["No", "Yes"],
};
const QUESTIONS = [ARRANGEMENT, ON_CALL];

function row(id: string, answers?: IndexRow["answers"]): IndexRow {
  return {
    id: `${id}${"0".repeat(16 - id.length)}`,
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
    postedAt: (TODAY - 1) * DAY,
    url: `https://example.com/jobs/${id}`,
    ...(answers === undefined ? {} : { answers }),
  };
}

/** Certainly remote, and certainly no on-call. */
const CERTAIN = row("certain", { arrangement: [100, 0, 0, 0], onCall: [100, 0] });
/** The model picked hybrid, but remote is nearly as likely. */
const SPLIT = row("split", { arrangement: [35, 40, 25, 0], onCall: [50, 50] });
/** Leaning remote, not certainly. */
const LEANING = row("leaning", { arrangement: [60, 20, 20, 0], onCall: [20, 80] });
/** Never asked. */
const UNASKED = row("unasked");

const ROWS = [CERTAIN, SPLIT, LEANING, UNASKED];

const shardsOf = (build: IndexBuild) =>
  build.files.filter((file) => file.path.includes("/shards/"));

async function table(
  rows: readonly IndexRow[] = ROWS,
  questions: readonly ShardQuestion[] = QUESTIONS,
) {
  const build = await buildIndex(rows, { builtAt: TODAY * DAY, facetsVersion: 1, questions });
  return openIndex(
    JSON.parse(build.files[0]?.content ?? ""),
    shardsOf(build).map((file) => JSON.parse(file.content)),
  );
}

const index = await table();
const ids = (result: ReturnType<typeof queryIndex>) =>
  result.rows.map((found) => found.id.replace(/0+$/, ""));
const run = (query: IndexQuery, from: IndexTable = index) =>
  queryIndex(from, { now: TODAY * DAY, ...query });

describe("a shard's answers", () => {
  it("carries the questions it holds answers to, so a reader needs no registry", async () => {
    const shard = JSON.parse(shardsOf(await buildAll()).at(0)?.content ?? "{}");
    expect(shard.questions).toEqual(QUESTIONS);
    // One flat run of probabilities per question, four rows wide.
    expect(shard.columns.answers).toHaveLength(2);
    expect(shard.columns.answers[0]).toHaveLength(4 * ARRANGEMENT.options.length);
    expect(shard.columns.answers[1]).toHaveLength(4 * ON_CALL.options.length);
  });

  it("marks which rows hold which answers", () => {
    expect(index.questions.map((question) => question.id)).toEqual(["arrangement", "onCall"]);
    // Both questions answered for the three asked rows, neither for the unasked one.
    const answered = [...index.answered];
    expect(answered.filter((bits) => bits === 0b11)).toHaveLength(3);
    expect(answered.filter((bits) => bits === 0)).toHaveLength(1);
  });

  it("leaves an unanswered row's probabilities as zeros, which is not the same as certainly not", () => {
    const [found] = run({ text: "unasked" }).rows;
    expect(found?.answers).toEqual([]);
  });

  it("gives a row its answers, likeliest option first named", () => {
    const [found] = run({ text: "split" }).rows;
    expect(found?.answers).toEqual([
      {
        question: "arrangement",
        option: "hybrid",
        probability: 40,
        distribution: [35, 40, 25, 0],
      },
      { question: "onCall", option: "no", probability: 50, distribution: [50, 50] },
    ]);
  });
});

describe("filtering on an answer", () => {
  it("asks for the probability of a set of options, not the one the model picked", () => {
    // "split" was called hybrid, but remote or hybrid together is 75%.
    expect(ids(run({ answers: [{ question: "arrangement", options: ["remote"], atLeast: 50 }] })));
    expect(
      ids(
        run({
          answers: [{ question: "arrangement", options: ["remote", "hybrid"], atLeast: 70 }],
        }),
      ).sort(),
    ).toEqual(["certain", "leaning", "split"]);
  });

  it("drops a posting the model picked when the option is not likely enough", () => {
    // Only "certain" (100) and "leaning" (60) reach 50% remote; "split" is 35%.
    expect(
      ids(run({ answers: [{ question: "arrangement", options: ["remote"], atLeast: 50 }] })).sort(),
    ).toEqual(["certain", "leaning"]);
    expect(
      ids(run({ answers: [{ question: "arrangement", options: ["remote"], atLeast: 80 }] })).sort(),
    ).toEqual(["certain"]);
  });

  it("treats a posting with no answer as no match, never as a maybe", () => {
    for (const atLeast of [0, 1, 50, 100]) {
      expect(
        ids(run({ answers: [{ question: "arrangement", options: ["remote"], atLeast }] })),
      ).not.toContain("unasked");
    }
  });

  it("reads a yes/no answer as two options, so no is a filter like any other", () => {
    expect(
      ids(run({ answers: [{ question: "onCall", options: ["yes"], atLeast: 70 }] })).sort(),
    ).toEqual(["leaning"]);
    expect(
      ids(run({ answers: [{ question: "onCall", options: ["no"], atLeast: 70 }] })).sort(),
    ).toEqual(["certain"]);
  });

  it("defaults to more likely than not", () => {
    const withDefault = run({ answers: [{ question: "arrangement", options: ["remote"] }] });
    const explicit = run({
      answers: [
        { question: "arrangement", options: ["remote"], atLeast: DEFAULT_ANSWER_THRESHOLD },
      ],
    });
    expect(ids(withDefault)).toEqual(ids(explicit));
  });

  it("stacks with the other filters", () => {
    expect(
      ids(
        run({
          places: { countries: ["DE"] },
          answers: [{ question: "arrangement", options: ["remote"], atLeast: 50 }],
        }),
      ).sort(),
    ).toEqual(["certain", "leaning"]);
    expect(
      ids(
        run({
          places: { countries: ["FR"] },
          answers: [{ question: "arrangement", options: ["remote"], atLeast: 50 }],
        }),
      ),
    ).toEqual([]);
  });

  it("stacks two questions, each on its own", () => {
    expect(
      ids(
        run({
          answers: [
            { question: "arrangement", options: ["remote"], atLeast: 50 },
            { question: "onCall", options: ["no"], atLeast: 70 },
          ],
        }),
      ),
    ).toEqual(["certain"]);
  });

  it("ignores a question or option the index does not carry, rather than matching nothing", () => {
    expect(ids(run({ answers: [{ question: "nonsense", options: ["yes"] }] })).length).toBe(
      ROWS.length,
    );
    expect(ids(run({ answers: [{ question: "arrangement", options: ["nonsense"] }] })).length).toBe(
      ROWS.length,
    );
  });
});

describe("answer facet counts", () => {
  const facetFor = (result: ReturnType<typeof queryIndex>, question: string) =>
    result.facets.answers.find((entry) => entry.question === question);

  it("says how many postings hold an answer at all, apart from what it says", () => {
    const facet = facetFor(run({}), "arrangement");
    // Three of four rows were asked; the fourth is not evidence either way.
    expect(facet?.answered).toBe(3);
  });

  it("promises what choosing an option would give, at the threshold in force", () => {
    const result = run({
      answers: [{ question: "arrangement", options: ["remote"], atLeast: 50 }],
    });
    const facet = facetFor(result, "arrangement");
    const remote = facet?.options.find(([option]) => option === "remote");
    expect(remote?.[1]).toBe(result.total);
    // Picking hybrid instead at the same threshold: "split" is 40, so none reach 50.
    expect(facet?.options.find(([option]) => option === "hybrid")).toBeUndefined();
  });

  it("leaves a question's own filter out of its own count", () => {
    // Only "certain" passes remote at 80, but the arrangement facet still counts all three
    // answered rows: otherwise it could only ever offer what is already chosen.
    const result = run({
      answers: [{ question: "arrangement", options: ["remote"], atLeast: 80 }],
    });
    expect(result.total).toBe(1);
    expect(facetFor(result, "arrangement")?.answered).toBe(3);
  });

  it("counts a question over the postings another question's filter leaves", () => {
    // arrangement has no filter here, so the on-call filter does narrow it: that is what makes
    // the count a promise about what choosing an arrangement next would give.
    const result = run({ answers: [{ question: "onCall", options: ["yes"], atLeast: 70 }] });
    expect(ids(result)).toEqual(["leaning"]);
    expect(facetFor(result, "arrangement")?.answered).toBe(1);
    expect(facetFor(result, "onCall")?.answered).toBe(3);
  });

  it("counts every option that reaches the threshold, not only the likeliest", () => {
    // At 20%, "leaning" reaches remote (60), hybrid (20) and onsite (20).
    const facet = facetFor(
      run({ answers: [{ question: "arrangement", options: ["remote"], atLeast: 20 }] }),
      "arrangement",
    );
    const counts = new Map(facet?.options);
    expect(counts.get("remote")).toBe(3);
    expect(counts.get("hybrid")).toBe(2);
  });
});

describe("a build with no questions", () => {
  it("carries no answer columns and answers nothing", async () => {
    const empty = await table(ROWS, []);
    expect(empty.questions).toEqual([]);
    expect(empty.answers).toEqual([]);
    expect(run({}, empty).facets.answers).toEqual([]);
    expect(run({}, empty).rows[0]?.answers).toEqual([]);
  });

  it("leaves out an answer to a question the build does not declare", async () => {
    const only = await table(ROWS, [ON_CALL]);
    expect(only.questions.map((question) => question.id)).toEqual(["onCall"]);
    const [found] = queryIndex(only, { now: TODAY * DAY, text: "certain" }).rows;
    expect(found?.answers.map((answer) => answer.question)).toEqual(["onCall"]);
  });
});

describe("the build name", () => {
  it("changes when a question is reworded, so stale answers are never served as fresh", async () => {
    const first = await buildIndex(ROWS, {
      builtAt: TODAY * DAY,
      facetsVersion: 1,
      questions: QUESTIONS,
    });
    const reworded = await buildIndex(ROWS, {
      builtAt: TODAY * DAY,
      facetsVersion: 1,
      questions: [{ ...ARRANGEMENT, version: 2 }, ON_CALL],
    });
    expect(reworded.manifest.build).not.toBe(first.manifest.build);
  });

  it("stays the same for the same corpus and the same questions", async () => {
    const options = { builtAt: TODAY * DAY, facetsVersion: 1, questions: QUESTIONS };
    const [first, again] = await Promise.all([
      buildIndex(ROWS, options),
      buildIndex(ROWS, options),
    ]);
    expect(again.manifest.build).toBe(first.manifest.build);
  });
});

describe("more questions than a shard can carry", () => {
  it("fails the build rather than misfiling answers into the wrong question", async () => {
    // `answered` is a bit per question in one number, and JavaScript's shift wraps at 32, so a
    // 33rd question would set bit 0 and read as the first question being answered.
    const many = Array.from({ length: MAX_SHARD_QUESTIONS + 1 }, (_, at) => ({
      ...ON_CALL,
      id: `q${at}`,
    }));
    await expect(
      buildIndex(ROWS, { builtAt: TODAY * DAY, facetsVersion: 1, questions: many }),
    ).rejects.toThrow(/exceeds the 31 a shard can carry/);
  });

  it("allows exactly the most it can carry", async () => {
    const most = Array.from({ length: MAX_SHARD_QUESTIONS }, (_, at) => ({
      ...ON_CALL,
      id: `q${at}`,
    }));
    const build = await buildIndex(ROWS, {
      builtAt: TODAY * DAY,
      facetsVersion: 1,
      questions: most,
    });
    // The top bit must stay positive, which the shard schema requires.
    const shard = JSON.parse(shardsOf(build).at(0)?.content ?? "{}");
    expect(Math.max(...shard.columns.answered)).toBeGreaterThanOrEqual(0);
  });
});

describe("shards from two builds", () => {
  it("are refused rather than read against each other's options", async () => {
    const mine = await buildIndex(ROWS, {
      builtAt: TODAY * DAY,
      facetsVersion: 1,
      questions: QUESTIONS,
    });
    const theirs = await buildIndex(ROWS, {
      builtAt: TODAY * DAY,
      facetsVersion: 1,
      questions: [ON_CALL],
    });
    expect(() =>
      openIndex(JSON.parse(mine.files[0]?.content ?? ""), [
        JSON.parse(shardsOf(mine)[0]?.content ?? ""),
        JSON.parse(shardsOf(theirs)[0]?.content ?? ""),
      ]),
    ).toThrow(/different questions/);
  });
});

async function buildAll() {
  return buildIndex(ROWS, { builtAt: TODAY * DAY, facetsVersion: 1, questions: QUESTIONS });
}
