import { DatabaseSync } from "node:sqlite";
import { schemaVersion } from "./database.ts";
import { SNAPSHOT_SEQ_KEY } from "./snapshot.ts";

export interface StoreReport {
  readonly integrity: readonly string[];
  readonly schemaVersion: number;
  readonly snapshotSeq: number;
  readonly boards: Readonly<Record<string, number>>;
  readonly postings: number;
  readonly crawls: number;
  readonly lastRun: {
    readonly id: string;
    readonly status: string;
    readonly startedAt: number;
    readonly finishedAt: number | null;
  } | null;
}

/**
 * Opens a store read-only and reports its health and size, without migrating or changing it.
 * `integrity` is `["ok"]` for a healthy file.
 */
export function inspectStore(path: string): StoreReport {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = (
      db.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[]
    ).map((row) => row.integrity_check);
    const seq = db.prepare("SELECT value FROM store_meta WHERE key = ?").get(SNAPSHOT_SEQ_KEY) as
      | { value: string }
      | undefined;
    const boards = Object.fromEntries(
      (
        db
          .prepare("SELECT status, count(*) AS n FROM boards GROUP BY status ORDER BY status")
          .all() as {
          status: string;
          n: number;
        }[]
      ).map((row) => [row.status, row.n]),
    );
    const count = (table: string) =>
      (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
    const lastRun = db
      .prepare(
        "SELECT id, status, started_at, finished_at FROM runs ORDER BY started_at DESC LIMIT 1",
      )
      .get() as
      | { id: string; status: string; started_at: number; finished_at: number | null }
      | undefined;
    return {
      integrity,
      schemaVersion: schemaVersion(db),
      snapshotSeq: Number(seq?.value ?? "0"),
      boards,
      postings: count("postings"),
      crawls: count("board_crawls"),
      lastRun:
        lastRun === undefined
          ? null
          : {
              id: lastRun.id,
              status: lastRun.status,
              startedAt: lastRun.started_at,
              finishedAt: lastRun.finished_at,
            },
    };
  } finally {
    db.close();
  }
}
