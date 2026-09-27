import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openPipelineStore, type PipelineStore } from "./pipeline-store.ts";
import {
  manifestName,
  manifestSeq,
  packSnapshot,
  parseStoreKey,
  SnapshotError,
  snapshotManifestSchema,
  snapshotName,
  snapshotSeq,
  storeSeq,
  unpackSnapshot,
} from "./snapshot.ts";

const KEY = new Uint8Array(randomBytes(32));
const NOW = Date.UTC(2026, 8, 27, 3, 40);

let dir: string;
let store: PipelineStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "quarry-snapshot-"));
  store = openPipelineStore(join(dir, "live.sqlite"));
  store.syncBoards([{ source: "lever", slug: "acme", company: "Acme", country: "US" }], [], NOW);
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

async function pack(runId = "gh-1-1") {
  return packSnapshot(store, { dir, runId, key: KEY, now: () => NOW });
}

describe("packSnapshot and unpackSnapshot", () => {
  it("round-trips the store and numbers snapshots in sequence", async () => {
    expect(storeSeq(store)).toBe(0);
    const { manifest, snapshotPath, manifestPath } = await pack();
    expect(manifest).toMatchObject({
      format: 1,
      seq: 1,
      runId: "gh-1-1",
      createdAt: "2026-09-27T03:40:00.000Z",
      schemaVersion: 1,
      snapshot: { name: "store-00000001-gh-1-1.sqlite.br.enc" },
    });
    expect(snapshotManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")))).toEqual(
      manifest,
    );
    expect((await stat(snapshotPath)).size).toBe(manifest.snapshot.bytes);

    const restoredPath = join(dir, "restored.sqlite");
    await unpackSnapshot(snapshotPath, manifest, KEY, restoredPath);
    const restored = openPipelineStore(restoredPath);
    expect(storeSeq(restored)).toBe(1);
    expect(restored.activeBoards().map((board) => board.id)).toEqual(["lever:acme"]);
    restored.close();

    expect((await pack("gh-2-1")).manifest.seq).toBe(2);
  });

  it("detects any change to the file before decrypting", async () => {
    const { manifest, snapshotPath } = await pack();
    const bytes = await readFile(snapshotPath);
    bytes[bytes.length - 20] = (bytes[bytes.length - 20] ?? 0) ^ 1;
    await writeFile(snapshotPath, bytes);
    await expect(
      unpackSnapshot(snapshotPath, manifest, KEY, join(dir, "x.sqlite")),
    ).rejects.toThrow(/checksum/);
  });

  it("rejects altered ciphertext even when the checksum is updated to match", async () => {
    const { manifest, snapshotPath } = await pack();
    const bytes = await readFile(snapshotPath);
    bytes[30] = (bytes[30] ?? 0) ^ 1;
    await writeFile(snapshotPath, bytes);
    const { createHash } = await import("node:crypto");
    const forged = {
      ...manifest,
      snapshot: { ...manifest.snapshot, sha256: createHash("sha256").update(bytes).digest("hex") },
    };
    const destination = join(dir, "x.sqlite");
    await expect(unpackSnapshot(snapshotPath, forged, KEY, destination)).rejects.toThrow(
      SnapshotError,
    );
    await expect(stat(destination)).rejects.toThrow();
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(dir)).filter((name) => name.endsWith(".partial"))).toEqual([]);
  });

  it("rejects the wrong key", async () => {
    const { manifest, snapshotPath } = await pack();
    const otherKey = new Uint8Array(randomBytes(32));
    await expect(
      unpackSnapshot(snapshotPath, manifest, otherKey, join(dir, "x.sqlite")),
    ).rejects.toThrow(/could not be restored/);
  });

  it("rejects a snapshot whose recorded sequence differs from the manifest", async () => {
    const { manifest, snapshotPath } = await pack();
    const mislabeled = { ...manifest, seq: 7 };
    await expect(
      unpackSnapshot(snapshotPath, mislabeled, KEY, join(dir, "x.sqlite")),
    ).rejects.toThrow(/snapshot 7 was expected/);
  });

  it("refuses to overwrite an existing store", async () => {
    const { manifest, snapshotPath } = await pack();
    const destination = join(dir, "taken.sqlite");
    await writeFile(destination, "existing");
    await expect(unpackSnapshot(snapshotPath, manifest, KEY, destination)).rejects.toThrow(
      /already exists/,
    );
    expect(await readFile(destination, "utf8")).toBe("existing");
  });

  it("rejects files that are not snapshots", async () => {
    const path = join(dir, "not-a-snapshot");
    await writeFile(path, "short");
    const { createHash } = await import("node:crypto");
    const sha256 = createHash("sha256").update("short").digest("hex");
    const { manifest } = await pack();
    const fake = { ...manifest, snapshot: { ...manifest.snapshot, sha256 } };
    await expect(unpackSnapshot(path, fake, KEY, join(dir, "x.sqlite"))).rejects.toThrow(
      /truncated/,
    );
    const long = Buffer.alloc(64, 1);
    await writeFile(path, long);
    const longFake = {
      ...manifest,
      snapshot: { ...manifest.snapshot, sha256: createHash("sha256").update(long).digest("hex") },
    };
    await expect(unpackSnapshot(path, longFake, KEY, join(dir, "x.sqlite"))).rejects.toThrow(
      /Not a Quarry store snapshot/,
    );
  });
});

describe("parseStoreKey", () => {
  it("accepts exactly 32 base64-encoded bytes", () => {
    const encoded = Buffer.from(KEY).toString("base64");
    expect(parseStoreKey(`${encoded}\n`)).toEqual(KEY);
    expect(() => parseStoreKey(Buffer.alloc(16).toString("base64"))).toThrow(/32 bytes/);
    expect(() => parseStoreKey("not base64!")).toThrow(SnapshotError);
    expect(() => parseStoreKey("")).toThrow(SnapshotError);
  });
});

describe("snapshot names", () => {
  it("encode the sequence and a file-safe run id", () => {
    expect(manifestName(42)).toBe("manifest-00000042.json");
    expect(snapshotName(42, "local-2026-09-27T03:40:00.000Z")).toBe(
      "store-00000042-local-2026-09-27T03_40_00.000Z.sqlite.br.enc",
    );
    expect(manifestSeq("manifest-00000042.json")).toBe(42);
    expect(manifestSeq("manifest-42.json")).toBeUndefined();
    expect(snapshotSeq("store-00000042-gh-9-1.sqlite.br.enc")).toBe(42);
    expect(snapshotSeq("notes.txt")).toBeUndefined();
  });
});

describe("inspectStore", () => {
  it("reports health and size without changing the store", async () => {
    await pack();
    store.startRun({ id: "gh-5-1", trigger: "schedule", codeVersion: "abc", startedAt: NOW });
    const { inspectStore } = await import("./inspect.ts");
    expect(inspectStore(join(dir, "live.sqlite"))).toEqual({
      integrity: ["ok"],
      schemaVersion: 1,
      snapshotSeq: 1,
      boards: { active: 1 },
      postings: 0,
      crawls: 0,
      lastRun: { id: "gh-5-1", status: "running", startedAt: NOW, finishedAt: null },
    });
  });
});
