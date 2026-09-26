import { describe, expect, it } from "vitest";
import { migrate, openDatabase, schemaVersion, transaction } from "./database.ts";
import { PIPELINE_MIGRATIONS } from "./migrations.ts";

describe("migrate", () => {
  it("applies every migration once and records the version", () => {
    const db = openDatabase(":memory:");
    expect(migrate(db, PIPELINE_MIGRATIONS)).toEqual({ from: 0, to: PIPELINE_MIGRATIONS.length });
    expect(schemaVersion(db)).toBe(PIPELINE_MIGRATIONS.length);
    expect(migrate(db, PIPELINE_MIGRATIONS)).toEqual({
      from: PIPELINE_MIGRATIONS.length,
      to: PIPELINE_MIGRATIONS.length,
    });
  });

  it("refuses a database written by newer code", () => {
    const db = openDatabase(":memory:");
    db.exec("PRAGMA user_version = 99");
    expect(() => migrate(db, PIPELINE_MIGRATIONS)).toThrow(/newer than this code supports/);
  });

  it("requires consecutive versions starting at 1", () => {
    const db = openDatabase(":memory:");
    expect(() => migrate(db, [{ version: 2, name: "skip", sql: "" }])).toThrow(/version 1/);
  });

  it("rolls back a failing migration entirely", () => {
    const db = openDatabase(":memory:");
    const broken = [
      { version: 1, name: "broken", sql: "CREATE TABLE a (x INTEGER); SELECT nope;" },
    ];
    expect(() => migrate(db, broken)).toThrow();
    expect(schemaVersion(db)).toBe(0);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'a'").get()).toBeUndefined();
  });

  it("enforces foreign keys and strict column types", () => {
    const db = openDatabase(":memory:");
    migrate(db, PIPELINE_MIGRATIONS);
    expect(() =>
      db
        .prepare(
          "INSERT INTO postings VALUES ('p', 'missing-board', 'x', 'h', 't', 'u', '[]', NULL, 1, 1, 1, 1)",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      db.prepare("INSERT INTO store_meta (key, value) VALUES ('k', ?)").run(new Uint8Array(1)),
    ).toThrow(/cannot store BLOB/);
  });
});

describe("transaction", () => {
  it("commits on success and rolls back on error", () => {
    const db = openDatabase(":memory:");
    db.exec("CREATE TABLE t (x INTEGER) STRICT");
    transaction(db, () => db.exec("INSERT INTO t VALUES (1)"));
    expect(() =>
      transaction(db, () => {
        db.exec("INSERT INTO t VALUES (2)");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(db.prepare("SELECT x FROM t").all()).toEqual([{ x: 1 }]);
  });

  it("does not nest", () => {
    const db = openDatabase(":memory:");
    expect(() => transaction(db, () => transaction(db, () => 1))).toThrow(/do not nest/);
  });
});
