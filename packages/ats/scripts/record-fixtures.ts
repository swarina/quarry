/**
 * Records live listing responses as contract-test fixtures: real data, trimmed to a few jobs per
 * board, with email addresses replaced. Non-ASCII characters are written as JSON `\u` escapes,
 * so the files are plain ASCII yet decode to exactly the recorded text.
 *
 * Usage: pnpm --filter @quarry/ats record-fixtures
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AtsSource } from "@quarry/domain";
import { listingRequest } from "../src/index.ts";

const USER_AGENT = "QuarryBot/0.1 (+https://github.com/swarina/quarry)";
const JOBS_PER_BOARD = 3;
const REQUEST_GAP_MS = 1_100;
const FIXTURES_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), "fixtures");

type Job = Record<string, unknown>;

interface FixtureBoard {
  readonly source: AtsSource;
  readonly slug: string;
  /** Jobs that exercise something specific are recorded first. */
  readonly prefer?: (job: Job) => boolean;
}

const BOARDS: readonly FixtureBoard[] = [
  { source: "greenhouse", slug: "cabify", prefer: (job) => job["language"] !== "en" },
  { source: "greenhouse", slug: "discord" },
  { source: "lever", slug: "blueland" },
  { source: "lever", slug: "outreach", prefer: (job) => job["salaryRange"] != null },
  { source: "ashby", slug: "zapier", prefer: hasAshbySalary },
  { source: "ashby", slug: "0g", prefer: (job) => job["workplaceType"] === null },
];

function hasAshbySalary(job: Job): boolean {
  const compensation = job["compensation"] as { summaryComponents?: Job[] } | null | undefined;
  return (compensation?.summaryComponents ?? []).some(
    (component) => component["compensationType"] === "Salary",
  );
}

function selectJobs(jobs: Job[], prefer: ((job: Job) => boolean) | undefined): Job[] {
  const preferred = prefer === undefined ? [] : jobs.filter(prefer);
  const rest = jobs.filter((job) => !preferred.includes(job));
  // Keep one ordinary job when there is one, so fixtures are not all edge cases.
  const picked = [...preferred.slice(0, JOBS_PER_BOARD - 1), ...rest.slice(0, 1)];
  const fill = [...preferred.slice(JOBS_PER_BOARD - 1), ...rest.slice(1)];
  return [...picked, ...fill].slice(0, JOBS_PER_BOARD);
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function scrub(value: unknown): unknown {
  if (typeof value === "string") return value.replace(EMAIL, "redacted@example.com");
  if (Array.isArray(value)) return value.map(scrub);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, scrub(entry)]));
  }
  return value;
}

function toAsciiJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2).replace(
    /[^\x20-\x7e\n]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  )}\n`;
}

await mkdir(FIXTURES_DIR, { recursive: true });
for (const [index, board] of BOARDS.entries()) {
  if (index > 0) await new Promise((resolve) => setTimeout(resolve, REQUEST_GAP_MS));
  const { url } = listingRequest(board.source, board.slug);
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT } });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  const body = (await response.json()) as Job[] | { jobs: Job[] };
  const jobs = Array.isArray(body) ? body : body.jobs;
  const selected = selectJobs(jobs, board.prefer);
  const trimmed = Array.isArray(body) ? selected : { ...body, jobs: selected };
  const fixture = {
    source: board.source,
    slug: board.slug,
    url,
    recordedAt: new Date().toISOString().slice(0, 10),
    body: scrub(trimmed),
  };
  const path = join(FIXTURES_DIR, `${board.source}-${board.slug}.json`);
  await writeFile(path, toAsciiJson(fixture), "utf8");
  console.log(`${path}: ${selected.length} of ${jobs.length} jobs`);
}
