import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { open, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import { constants, createBrotliCompress, createBrotliDecompress } from "node:zlib";
import { z } from "zod";
import { schemaVersion } from "./database.ts";
import type { PipelineStore } from "./pipeline-store.ts";

/**
 * Snapshot file layout (ADR-0006): `QSNP`, a format byte, a 12-byte IV, then the store's
 * SQLite file compressed with brotli and encrypted with AES-256-GCM, then the 16-byte GCM tag.
 * The header is authenticated too, so any change to any byte fails decryption.
 */
const MAGIC = Buffer.from("QSNP", "ascii");
const FORMAT = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + 1 + IV_BYTES;
const KEY_BYTES = 32;

export const SNAPSHOT_SEQ_KEY = "snapshot_seq";
const SNAPSHOT_RUN_KEY = "snapshot_run_id";

const SNAPSHOT_NAME = /^store-(\d{8})-[A-Za-z0-9._-]+\.sqlite\.br\.enc$/;
const MANIFEST_NAME = /^manifest-(\d{8})\.json$/;

export const snapshotManifestSchema = z.strictObject({
  format: z.literal(FORMAT),
  seq: z.int().positive(),
  runId: z.string().min(1),
  createdAt: z.iso.datetime(),
  schemaVersion: z.int().nonnegative(),
  sqliteBytes: z.int().positive(),
  snapshot: z.strictObject({
    name: z.string().regex(SNAPSHOT_NAME),
    bytes: z.int().positive(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
});

export type SnapshotManifest = z.infer<typeof snapshotManifestSchema>;

export class SnapshotError extends Error {
  override readonly name = "SnapshotError";
}

/** Decodes the base64 `QUARRY_STORE_KEY` into a 256-bit key, or throws `SnapshotError`. */
export function parseStoreKey(base64: string): Uint8Array {
  const key = Buffer.from(base64.trim(), "base64");
  if (key.length !== KEY_BYTES || key.toString("base64") !== base64.trim()) {
    throw new SnapshotError(`The store key must be ${KEY_BYTES} bytes, base64-encoded`);
  }
  return new Uint8Array(key);
}

export function manifestName(seq: number): string {
  return `manifest-${pad(seq)}.json`;
}

export function snapshotName(seq: number, runId: string): string {
  return `store-${pad(seq)}-${runId.replace(/[^A-Za-z0-9._-]/g, "_")}.sqlite.br.enc`;
}

/** The sequence number in a manifest file name, or undefined for any other name. */
export function manifestSeq(name: string): number | undefined {
  const match = MANIFEST_NAME.exec(name);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/** The sequence number in a snapshot file name, or undefined for any other name. */
export function snapshotSeq(name: string): number | undefined {
  const match = SNAPSHOT_NAME.exec(name);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/** The snapshot sequence the store descends from; 0 for a store that was never snapshotted. */
export function storeSeq(store: PipelineStore): number {
  return Number(store.getMeta(SNAPSHOT_SEQ_KEY) ?? "0");
}

/**
 * Writes the next snapshot of `store` into `dir`: a consistent copy via `VACUUM INTO`, checked
 * with `PRAGMA integrity_check`, compressed, and encrypted, plus its manifest. The snapshot
 * records its own sequence number, so a restore can prove it got the snapshot it asked for.
 */
export async function packSnapshot(
  store: PipelineStore,
  options: {
    readonly dir: string;
    readonly runId: string;
    readonly key: Uint8Array;
    readonly now?: () => number;
  },
): Promise<{
  readonly manifest: SnapshotManifest;
  readonly manifestPath: string;
  readonly snapshotPath: string;
}> {
  const seq = storeSeq(store) + 1;
  store.setMeta(SNAPSHOT_SEQ_KEY, String(seq));
  store.setMeta(SNAPSHOT_RUN_KEY, options.runId);

  const plainPath = join(options.dir, `store-${pad(seq)}.sqlite`);
  const name = snapshotName(seq, options.runId);
  const snapshotPath = join(options.dir, name);
  await rm(plainPath, { force: true });
  try {
    store.db.prepare("VACUUM INTO ?").run(plainPath);
    const version = verifyDatabase(plainPath, seq);
    const sqliteBytes = (await stat(plainPath)).size;

    const iv = randomBytes(IV_BYTES);
    const header = Buffer.concat([MAGIC, Buffer.from([FORMAT]), iv]);
    const cipher = createCipheriv("aes-256-gcm", options.key, iv);
    cipher.setAAD(header);
    const hash = createHash("sha256");
    const output = await open(snapshotPath, "w");
    let bytes = 0;
    const write = async (chunk: Uint8Array) => {
      hash.update(chunk);
      bytes += chunk.byteLength;
      await output.write(chunk);
    };
    try {
      await write(header);
      await pipeline(
        createReadStream(plainPath),
        createBrotliCompress({
          params: {
            [constants.BROTLI_PARAM_QUALITY]: 5,
            [constants.BROTLI_PARAM_SIZE_HINT]: sqliteBytes,
          },
        }),
        cipher,
        async (source: AsyncIterable<Buffer>) => {
          for await (const chunk of source) await write(chunk);
        },
      );
      await write(cipher.getAuthTag());
    } finally {
      await output.close();
    }

    const manifest: SnapshotManifest = {
      format: FORMAT,
      seq,
      runId: options.runId,
      createdAt: new Date((options.now ?? Date.now)()).toISOString(),
      schemaVersion: version,
      sqliteBytes,
      snapshot: { name, bytes, sha256: hash.digest("hex") },
    };
    const manifestPath = join(options.dir, manifestName(seq));
    const file = await open(manifestPath, "w");
    try {
      await file.writeFile(`${JSON.stringify(manifest, null, 2)}\n`);
    } finally {
      await file.close();
    }
    return { manifest, manifestPath, snapshotPath };
  } finally {
    await rm(plainPath, { force: true });
  }
}

/**
 * Restores a snapshot to `destination`, which must not exist yet. Verifies, in order: the
 * file's SHA-256 against the manifest, the header, the GCM tag (so the key is right and nothing
 * was altered), SQLite's integrity check, and the sequence number recorded inside the store.
 * Nothing is left at `destination` unless every check passes.
 */
export async function unpackSnapshot(
  snapshotPath: string,
  manifest: SnapshotManifest,
  key: Uint8Array,
  destination: string,
): Promise<void> {
  if (await exists(destination)) throw new SnapshotError(`${destination} already exists`);
  const actual = await sha256File(snapshotPath);
  if (actual !== manifest.snapshot.sha256) {
    throw new SnapshotError(`Snapshot checksum ${actual} does not match the manifest`);
  }
  const file = await open(snapshotPath, "r");
  let header: Buffer;
  let tag: Buffer;
  let size: number;
  try {
    size = (await file.stat()).size;
    if (size < HEADER_BYTES + TAG_BYTES) throw new SnapshotError("Snapshot file is truncated");
    header = Buffer.alloc(HEADER_BYTES);
    tag = Buffer.alloc(TAG_BYTES);
    await file.read(header, 0, HEADER_BYTES, 0);
    await file.read(tag, 0, TAG_BYTES, size - TAG_BYTES);
  } finally {
    await file.close();
  }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC) || header[MAGIC.length] !== FORMAT) {
    throw new SnapshotError("Not a Quarry store snapshot, or an unsupported format");
  }

  const decipher = createDecipheriv("aes-256-gcm", key, header.subarray(MAGIC.length + 1));
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  const partial = `${destination}.${randomBytes(6).toString("hex")}.partial`;
  try {
    await pipeline(
      createReadStream(snapshotPath, { start: HEADER_BYTES, end: size - TAG_BYTES - 1 }),
      decipher,
      createBrotliDecompress(),
      createWriteStream(partial, { flags: "wx" }),
    );
    verifyDatabase(partial, manifest.seq);
    await rename(partial, destination);
  } catch (error) {
    await rm(partial, { force: true });
    if (error instanceof SnapshotError) throw error;
    throw new SnapshotError(
      `Snapshot ${manifest.snapshot.name} could not be restored: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Integrity-checks a store file and confirms its snapshot sequence; returns its schema version. */
function verifyDatabase(path: string, expectedSeq: number): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const problems = (db.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[])
      .map((row) => row.integrity_check)
      .filter((result) => result !== "ok");
    if (problems.length > 0) {
      throw new SnapshotError(
        `Store failed its integrity check: ${problems.slice(0, 5).join("; ")}`,
      );
    }
    const row = db.prepare("SELECT value FROM store_meta WHERE key = ?").get(SNAPSHOT_SEQ_KEY) as
      | { value: string }
      | undefined;
    if (row?.value !== String(expectedSeq)) {
      throw new SnapshotError(
        `Store records snapshot ${row?.value ?? "none"}, but snapshot ${expectedSeq} was expected`,
      );
    }
    return schemaVersion(db);
  } finally {
    db.close();
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

function pad(seq: number): string {
  return String(seq).padStart(8, "0");
}
