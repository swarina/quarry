import { type IndexQuery, type IndexTable, openIndex, parseManifest } from "@quarry/search-index";
import { byId, el, fill } from "./dom.ts";

/**
 * Measures what M2 asks for: filtering the whole index, in a real browser, under 100 ms at the
 * 95th percentile. It loads every region, so it is the worst case rather than the one region a
 * visitor downloads, and runs a spread of queries like the ones the page sends.
 *
 * Open /bench.html to run it. It is a page rather than a script so it measures the browser the
 * person actually uses.
 */
const TARGET_MS = 100;
const RUNS = 200;

async function fetchJson(path: string): Promise<unknown> {
  const response = await fetch(`index/${path}`);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return await response.json();
}

function queries(table: IndexTable): { name: string; query: IndexQuery }[] {
  const countries = table.dictionaries.country.slice(0, 3);
  const company = table.dictionaries.company[0] ?? "";
  return [
    { name: "everything, newest first", query: {} },
    { name: "one country", query: { places: { countries: countries.slice(0, 1) } } },
    { name: "three countries", query: { places: { countries } } },
    { name: "remote, full time", query: { workplaces: ["remote"], employment: ["full-time"] } },
    { name: "text: engineer", query: { text: "engineer" } },
    { name: "text: senior software engineer", query: { text: "senior software engineer" } },
    { name: "one company", query: { companies: [company] } },
    { name: "posted in the last 7 days", query: { postedWithinDays: 7 } },
    { name: "pay at least 100k USD", query: { minimumPay: { amount: 100_000, currency: "USD" } } },
    { name: "sorted by pay", query: { sort: { pay: "USD" } } },
    {
      name: "everything at once",
      query: {
        places: { countries },
        workplaces: ["remote", "hybrid"],
        employment: ["full-time"],
        postedWithinDays: 30,
        text: "engineer",
        sort: { pay: "USD" },
      },
    },
  ];
}

function percentile(sorted: readonly number[], share: number): number {
  const rank = Math.ceil(share * sorted.length) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)] ?? 0;
}

async function run(): Promise<void> {
  const status = byId("status");
  status.textContent = "Loading every region";
  const manifest = parseManifest(await fetchJson("manifest.json"));
  const entries = manifest.regions.flatMap((region) => region.shards);
  const shards = await Promise.all(entries.map(async (shard) => await fetchJson(shard.path)));

  const openedAt = performance.now();
  const table = openIndex(manifest, shards);
  const openMs = performance.now() - openedAt;

  const { queryIndex } = await import("@quarry/search-index");
  status.textContent = `Running ${RUNS} queries over ${table.size.toLocaleString("en-US")} postings`;
  await new Promise((resolve) => setTimeout(resolve, 0));

  const cases = queries(table);
  const rows: { name: string; p50: number; p95: number; worst: number; total: number }[] = [];
  const all: number[] = [];
  for (const { name, query } of cases) {
    const times: number[] = [];
    let total = 0;
    for (let run = 0; run < RUNS; run += 1) {
      const started = performance.now();
      total = queryIndex(table, { ...query, now: Date.now() }).total;
      times.push(performance.now() - started);
    }
    times.sort((left, right) => left - right);
    all.push(...times);
    rows.push({
      name,
      p50: percentile(times, 0.5),
      p95: percentile(times, 0.95),
      worst: times[times.length - 1] ?? 0,
      total,
    });
  }
  all.sort((left, right) => left - right);
  const overall = percentile(all, 0.95);

  const cell = (value: string) => el("td", { text: value });
  fill(byId("results"), [
    el("p", {
      class: overall <= TARGET_MS ? "pass" : "fail",
      text:
        `${overall <= TARGET_MS ? "Within budget" : "Over budget"}: ` +
        `${overall.toFixed(1)} ms at the 95th percentile over ${all.length.toLocaleString("en-US")} queries ` +
        `(budget ${TARGET_MS} ms), on ${table.size.toLocaleString("en-US")} postings in ${entries.length} shards. ` +
        `Decoding them took ${openMs.toFixed(0)} ms.`,
    }),
    el("table", {}, [
      el("thead", {}, [
        el("tr", {}, [
          el("th", { text: "Query" }),
          el("th", { text: "Matches" }),
          el("th", { text: "Median" }),
          el("th", { text: "95th" }),
          el("th", { text: "Worst" }),
        ]),
      ]),
      el(
        "tbody",
        {},
        rows.map((row) =>
          el("tr", {}, [
            cell(row.name),
            cell(row.total.toLocaleString("en-US")),
            cell(`${row.p50.toFixed(2)} ms`),
            cell(`${row.p95.toFixed(2)} ms`),
            cell(`${row.worst.toFixed(2)} ms`),
          ]),
        ),
      ),
    ]),
  ]);
  status.textContent = "";
}

run().catch((error: unknown) => {
  byId("status").textContent = error instanceof Error ? error.message : String(error);
});
