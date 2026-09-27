import { DatabaseSync } from "node:sqlite";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

/**
 * Opens a SQLite database with the settings every Quarry store uses: foreign keys enforced,
 * WAL journaling, and `synchronous = NORMAL`. Durability comes from snapshots (ADR-0006), so
 * the rare loss of the last transaction on power failure is acceptable in exchange for speed.
 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  return db;
}

/**
 * Runs `work` in a transaction that takes the write lock up front, committing if it returns and
 * rolling back if it throws. Transactions do not nest.
 */
export function transaction<T>(db: DatabaseSync, work: () => T): T {
  if (db.isTransaction) throw new Error("Transactions do not nest");
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
}

/**
 * Applies every migration newer than the database's `user_version`, each in its own
 * transaction. Refuses to open a database written by newer code, because older code could
 * misread or damage it.
 */
export function migrate(
  db: DatabaseSync,
  migrations: readonly Migration[],
): { readonly from: number; readonly to: number } {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(`Migration ${migration.name} must have version ${index + 1}`);
    }
  });
  const from = schemaVersion(db);
  const latest = migrations.length;
  if (from > latest) {
    throw new Error(`Store schema version ${from} is newer than this code supports (${latest})`);
  }
  for (const migration of migrations.slice(from)) {
    transaction(db, () => {
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${migration.version}`);
    });
  }
  return { from, to: latest };
}
