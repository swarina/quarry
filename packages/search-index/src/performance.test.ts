import { describe, expect, it } from "vitest";
import { buildIndex, type IndexBuild, type IndexRow } from "./build.ts";
import type { ShardQuestion } from "./format.ts";
import { type IndexQuery, queryIndex } from "./query.ts";
import { openIndex } from "./table.ts";

/** Shard files only; `build.files` also holds the manifest and the links files. */
const shardsOf = (build: IndexBuild) =>
  build.files.filter((file) => file.path.includes("/shards/"));

const DAY = 24 * 60 * 60 * 1000;
const TODAY = 20_725;
const ROWS = 100_000;
/**
 * The target is 100 ms at p95 in a mid-range laptop browser (M2). CI runners vary, so this only
 * catches a slide into slow; the numbers it logs are the ones to watch.
 */
const P95_LIMIT_MS = 250;

// Real places, weighted roughly like the corpus: mostly the US, then Europe and Asia.
const PLACES = [
  { country: "US", division: "CA", city: 5391959 },
  { country: "US", division: "NY", city: 5128581 },
  { country: "US", division: "WA", city: 5809844 },
  { country: "US", division: "TX", city: 4671654 },
  { country: "GB", division: "ENG", city: 2643743 },
  { country: "DE", division: "16", city: 2950159 },
  { country: "FR", division: "11", city: 2988507 },
  { country: "IN", division: "19", city: 1277333 },
  { country: "SG", division: null, city: null },
  { country: "CA", division: "08", city: 6167865 },
] as const;
const WORDS = ["Senior", "Staff", "Backend", "Frontend", "Data", "Product", "Platform", "Security"];
const ROLES = ["Engineer", "Manager", "Designer", "Scientist", "Analyst", "Recruiter", "Lead"];

/** A small linear congruential generator, so the rows are the same on every run. */
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2 ** 31;
    return state / 2 ** 31;
  };
}

/** The standard questions' shapes, which is what decides the width of the answer columns. */
const QUESTIONS: readonly ShardQuestion[] = [
  {
    id: "arrangement",
    version: 1,
    about: "Where the work is done",
    kind: "choice",
    options: ["remote", "hybrid", "onsite", "not_stated"],
    labels: ["Remote", "Hybrid", "On site", "Not stated"],
  },
  {
    id: "seniority",
    version: 1,
    about: "How senior the role is",
    kind: "score",
    options: ["0", "1", "2", "3", "4"],
    labels: ["Intern", "Entry", "Mid", "Senior", "Staff"],
  },
  {
    id: "sponsorship",
    version: 1,
    about: "Whether sponsorship is offered",
    kind: "choice",
    options: ["offers", "does_not_offer", "not_mentioned"],
    labels: ["Offers", "Does not offer", "Not mentioned"],
  },
  {
    id: "onCall",
    version: 1,
    about: "Whether the role is on call",
    kind: "noul",
    options: ["no", "yes"],
    labels: ["No", "Yes"],
  },
];

/**
 * A peaked distribution summing to 100, as a confident model gives: one option takes most of
 * the mass. Peaked rather than uniform because that is what the columns really hold, and it is
 * the shape gzip sees.
 */
function peaked(next: () => number, width: number): number[] {
  const top = Math.floor(next() * width);
  const mass = 60 + Math.floor(next() * 40);
  const out = Array.from({ length: width }, () => 0);
  let left = 100 - mass;
  for (let option = 0; option < width; option += 1) {
    if (option === top) continue;
    const take = Math.floor(next() * (left + 1));
    out[option] = take;
    left -= take;
  }
  out[top] = mass + left;
  return out;
}

function syntheticRows(): IndexRow[] {
  const next = random(42);
  const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)] as T;
  return Array.from({ length: ROWS }, (_, index) => {
    const place = pick(PLACES);
    const paid = next() < 0.3;
    return {
      id: index.toString(36).padStart(16, "0"),
      url: `https://example.com/jobs/${index}`,
      title: `${pick(WORDS)} ${pick(WORDS)} ${pick(ROLES)}`,
      company: `Company ${Math.floor(next() * 400)}`,
      locations: [String(place.city ?? place.country)],
      places: [place],
      anywhere: next() < 0.01,
      inferred: false,
      workplace: pick(["remote", "hybrid", "onsite", null] as const),
      employmentTypes: [pick(["full-time", "part-time", "contract", "internship"] as const)],
      department: pick(["Engineering", "Sales", "Marketing", null]),
      pay: paid
        ? {
            min: 80_000 + Math.floor(next() * 100_000),
            max: null,
            currency: "USD",
            statedPer: "year",
          }
        : null,
      postedAt: (TODAY - Math.floor(next() * 120)) * DAY,
      // Every posting answered, which is the largest the columns ever get.
      answers: Object.fromEntries(
        QUESTIONS.map((question) => [question.id, peaked(next, question.options.length)]),
      ),
    };
  });
}

const QUERIES: readonly [string, IndexQuery][] = [
  ["everything", {}],
  ["a country", { places: { countries: ["DE"] } }],
  ["remote in a country", { places: { countries: ["US"] }, workplaces: ["remote"] }],
  ["a city, full-time", { places: { cities: [5391959] }, employment: ["full-time"] }],
  ["two words of text", { text: "senior engineer" }],
  ["recent, text, country", { places: { countries: ["GB"] }, postedWithinDays: 7, text: "data" }],
  [
    "pay, sorted by pay",
    { minimumPay: { amount: 150_000, currency: "USD" }, sort: { pay: "USD" } },
  ],
  ["likely remote", { answers: [{ question: "arrangement", options: ["remote"], atLeast: 70 }] }],
  [
    "likely remote, senior, no on-call, in a country",
    {
      places: { countries: ["US"] },
      answers: [
        { question: "arrangement", options: ["remote", "hybrid"], atLeast: 60 },
        { question: "seniority", options: ["3", "4"], atLeast: 50 },
        { question: "onCall", options: ["no"], atLeast: 60 },
      ],
    },
  ],
];

describe("query speed", () => {
  it(`filters ${ROWS.toLocaleString("en-US")} postings within budget`, async () => {
    const build = await buildIndex(syntheticRows(), {
      builtAt: TODAY * DAY,
      facetsVersion: 1,
      questions: QUESTIONS,
    });
    // Answers must not cost the premise of ADR-0007: a shard still downloads on a phone.
    expect(build.overBudget).toEqual([]);
    const manifest = build.files[0];
    const shards = shardsOf(build);
    const table = openIndex(
      JSON.parse(manifest?.content ?? ""),
      shards.map((file) => JSON.parse(file.content)),
    );
    expect(table.size).toBe(ROWS);

    for (const [name, query] of QUERIES) {
      const times: number[] = [];
      for (let run = 0; run < 20; run += 1) {
        const start = performance.now();
        queryIndex(table, { now: TODAY * DAY, ...query });
        times.push(performance.now() - start);
      }
      times.sort((left, right) => left - right);
      const p95 = times[Math.ceil(0.95 * times.length) - 1] ?? Number.POSITIVE_INFINITY;
      process.stdout.write(`  ${name}: p95 ${p95.toFixed(1)} ms\n`);
      expect(p95).toBeLessThan(P95_LIMIT_MS);
    }
  }, 60_000);
});
