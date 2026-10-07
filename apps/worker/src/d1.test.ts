/**
 * The D1 adapter, driven against `node:sqlite` through a shim that presents the same small D1
 * API the adapter is written to. This cannot prove the adapter on the real edge runtime (only a
 * deploy does that), but it proves the SQL and the logic: the chunking, the ambiguous-prefix
 * rule, the cache round-trip, and that a budget reservation is atomic under the capped total.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createD1AnswerCache,
  createD1BudgetStore,
  createD1PostingSource,
  type D1Database,
  type D1PreparedStatement,
  type D1Result,
} from "./d1.ts";

const SCHEMA = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "schema.sql"),
  "utf8",
);

/** Presents the slice of the D1 API the adapter uses, over a synchronous node:sqlite database. */
function shim(db: DatabaseSync): D1Database {
  const statement = (sql: string, args: readonly unknown[] = []): D1PreparedStatement => ({
    bind: (...values) => statement(sql, values),
    all: async <T>() =>
      ({ results: db.prepare(sql).all(...(args as never[])) as T[] }) as D1Result<T>,
  });
  // D1 runs batch transactions serialized against one another; node:sqlite is a single
  // synchronous connection, so the shim serializes batch() calls through a promise chain to model
  // that (and to avoid a reentrant BEGIN when callers overlap).
  let queue: Promise<unknown> = Promise.resolve();
  return {
    prepare: (sql) => statement(sql),
    batch: <T>(statements: readonly D1PreparedStatement[]) => {
      const run = queue.then(async (): Promise<D1Result<T>[]> => {
        db.exec("BEGIN");
        try {
          const out: D1Result<T>[] = [];
          for (const one of statements) out.push(await one.all<T>());
          db.exec("COMMIT");
          return out;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      });
      queue = run.catch(() => undefined);
      return run;
    },
  };
}

let raw: DatabaseSync;
let db: D1Database;

beforeEach(() => {
  raw = new DatabaseSync(":memory:");
  raw.exec(SCHEMA);
  db = shim(raw);
});

interface PostingOverrides {
  readonly contentHash?: string;
  readonly title?: string;
  readonly company?: string;
  readonly locationsJson?: string;
  readonly description?: string;
}

function insertPosting(id: string, overrides: PostingOverrides = {}): void {
  raw
    .prepare(
      `INSERT INTO criterion_postings (id, content_hash, title, company, locations_json, description)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      overrides.contentHash ?? `hash-${id}`,
      overrides.title ?? `Engineer ${id}`,
      overrides.company ?? "Example",
      overrides.locationsJson ?? JSON.stringify(["Berlin, Germany"]),
      overrides.description ?? `Description for ${id}`,
    );
}

describe("the D1 posting source", () => {
  it("resolves a prefix to its one posting", async () => {
    insertPosting("abcd1234efgh5678");
    const [posting] = await createD1PostingSource(db).read(["abcd1234efgh"]);
    expect(posting?.id).toBe("abcd1234efgh5678");
    expect(posting?.locations).toEqual(["Berlin, Germany"]);
    expect(posting?.description).toBe("Description for abcd1234efgh5678");
  });

  it("leaves out a prefix that matches more than one posting", async () => {
    // Two ids share the 12-character prefix: ambiguous, so neither is returned.
    insertPosting("samepfx00000AAAA");
    insertPosting("samepfx00000BBBB");
    const found = await createD1PostingSource(db).read(["samepfx00000"]);
    expect(found).toEqual([]);
  });

  it("leaves out a prefix that matches nothing", async () => {
    expect(await createD1PostingSource(db).read(["nothinghere0"])).toEqual([]);
  });

  it("resolves more prefixes than fit in one query's parameter limit", async () => {
    // 250 prefixes forces chunking (99 values per query); all must still come back.
    const ids = Array.from({ length: 250 }, (_v, at) => `p${String(at).padStart(11, "0")}`);
    for (const id of ids) insertPosting(id);
    const found = await createD1PostingSource(db).read(ids.map((id) => id.slice(0, 12)));
    expect(found).toHaveLength(250);
  });
});

describe("the D1 answer cache", () => {
  it("writes answers and reads back only the ones asked for", async () => {
    const cache = createD1AnswerCache(db, () => 1000);
    await cache.write("crit", "jev-1.13.0", [
      { contentHash: "h1", answerJson: '{"a":1}' },
      { contentHash: "h2", answerJson: '{"a":2}' },
    ]);
    const found = await cache.read("crit", "jev-1.13.0", ["h2", "h3"]);
    expect(found).toEqual([{ contentHash: "h2", answerJson: '{"a":2}' }]);
  });

  it("keeps answers for different models apart", async () => {
    const cache = createD1AnswerCache(db, () => 1000);
    await cache.write("crit", "jev-1.13.0", [{ contentHash: "h1", answerJson: '{"old":true}' }]);
    await cache.write("crit", "jev-2.0.0", [{ contentHash: "h1", answerJson: '{"new":true}' }]);
    expect(await cache.read("crit", "jev-2.0.0", ["h1"])).toEqual([
      { contentHash: "h1", answerJson: '{"new":true}' },
    ]);
  });

  it("overwrites an answer for the same key rather than duplicating it", async () => {
    const cache = createD1AnswerCache(db, () => 1000);
    await cache.write("crit", "m", [{ contentHash: "h1", answerJson: "first" }]);
    await cache.write("crit", "m", [{ contentHash: "h1", answerJson: "second" }]);
    const found = await cache.read("crit", "m", ["h1"]);
    expect(found).toEqual([{ contentHash: "h1", answerJson: "second" }]);
  });
});

describe("the D1 budget store", () => {
  it("grants up to what is wanted, then only what is left under the cap", async () => {
    const budget = createD1BudgetStore(db);
    expect(await budget.reserve("2026-10-07", 600, 1000)).toBe(600);
    expect(await budget.committed("2026-10-07")).toBe(600);
    // 600 already committed against a 1000 cap leaves 400, even though 600 was wanted.
    expect(await budget.reserve("2026-10-07", 600, 1000)).toBe(400);
    expect(await budget.reserve("2026-10-07", 600, 1000)).toBe(0);
  });

  it("returns released allowance to the day", async () => {
    const budget = createD1BudgetStore(db);
    await budget.reserve("2026-10-07", 1000, 1000);
    await budget.release("2026-10-07", 250);
    expect(await budget.committed("2026-10-07")).toBe(750);
    expect(await budget.reserve("2026-10-07", 100, 1000)).toBe(100);
  });

  it("never oversubscribes the cap across many concurrent reservations", async () => {
    const budget = createD1BudgetStore(db);
    // The batch transaction serializes these, so the grants can never sum to more than the cap.
    const grants = await Promise.all(
      Array.from({ length: 20 }, () => budget.reserve("2026-10-07", 100, 1000)),
    );
    expect(grants.reduce((total, grant) => total + grant, 0)).toBe(1000);
    expect(await budget.committed("2026-10-07")).toBe(1000);
  });
});
