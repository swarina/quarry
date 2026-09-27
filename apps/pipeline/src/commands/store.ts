import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  inspectStore,
  manifestName,
  manifestSeq,
  openPipelineStore,
  packSnapshot,
  parseStoreKey,
  snapshotManifestSchema,
  unpackSnapshot,
} from "@quarry/storage/node";
import { requireOption, UsageError, writeOut } from "../cli.ts";
import { runIdentity, storeKey, storeSettings, userAgent } from "../config.ts";
import { createLogger } from "../log.ts";
import {
  createReleaseAssets,
  type ReleaseAsset,
  type ReleaseAssets,
  STORE_RELEASE_TAG,
} from "../releases.ts";
import { prunableAssets } from "../retention.ts";

export const STORE_HELP = `  store pull               Restore the latest snapshot from the pipeline-store release.
    --store <path>           Where to write the store; must not exist (required)
    --bootstrap              Start an empty store when the release has no snapshots yet
    --prune-list <path>      Write the release assets retention no longer needs, one per line
  store pack               Write the store's next snapshot and manifest, encrypted.
    --store <path>           Store to snapshot (required)
    --out <dir>              Directory for the snapshot and manifest files (required)
  store verify             Check a store's integrity and print a summary as JSON.
    --store <path>           Store to check (required)
`;

export async function storeCommand(args: readonly string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "pull":
      return pull(rest);
    case "pack":
      return pack(rest);
    case "verify":
      return verify(rest);
    default:
      throw new UsageError(
        subcommand === undefined
          ? "store needs a subcommand: pull, pack, or verify"
          : `Unknown store subcommand: ${subcommand}`,
      );
  }
}

async function pull(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      store: { type: "string" },
      bootstrap: { type: "boolean", default: false },
      "prune-list": { type: "string" },
    },
    strict: true,
  });
  const storePath = requireOption(values.store, "--store");
  if (await exists(storePath)) throw new UsageError(`${storePath} already exists`);
  const settings = storeSettings();
  const key = parseStoreKey(settings.key);
  const identity = runIdentity(Date.now());
  const log = createLogger("pipeline", writeOut);
  const releases = createReleaseAssets({
    token: settings.token,
    repository: settings.repository,
    userAgent: userAgent(identity.codeVersion),
  });

  const result = await restoreLatest(releases, storePath, key, values.bootstrap);
  if (values["prune-list"] !== undefined) {
    const names = result.kind === "restored" ? prunableAssets(result.assets, Date.now()) : [];
    await writeFile(values["prune-list"], names.map((name) => `${name}\n`).join(""));
  }
  if (result.kind === "bootstrapped") {
    log.warn("store bootstrapped empty", { run_id: identity.runId });
  } else {
    log.info("store restored", { run_id: identity.runId, snapshot_seq: result.seq });
  }
  return 0;
}

type Restored =
  | { readonly kind: "bootstrapped" }
  | { readonly kind: "restored"; readonly seq: number; readonly assets: readonly ReleaseAsset[] };

/**
 * Restores the newest snapshot. Starting empty is allowed only when there is no snapshot at all
 * and the caller asked for it, so an API hiccup can never silently throw away the history.
 */
export async function restoreLatest(
  releases: ReleaseAssets,
  storePath: string,
  key: Uint8Array,
  bootstrap: boolean,
): Promise<Restored> {
  const assets = (await releases.list(STORE_RELEASE_TAG)) ?? [];
  const latest = assets
    .map((asset) => ({ asset, seq: manifestSeq(asset.name) }))
    .filter((entry): entry is { asset: ReleaseAsset; seq: number } => entry.seq !== undefined)
    .sort((left, right) => right.seq - left.seq)[0];

  if (latest === undefined) {
    if (!bootstrap) {
      throw new UsageError(
        `No snapshot in the "${STORE_RELEASE_TAG}" release. Run once with --bootstrap to start an empty store.`,
      );
    }
    openPipelineStore(storePath).close();
    return { kind: "bootstrapped" };
  }
  if (bootstrap) {
    throw new UsageError(
      `Snapshot ${latest.seq} exists; refusing to bootstrap over it. Run without --bootstrap.`,
    );
  }

  const work = await mkdtemp(join(tmpdir(), "quarry-pull-"));
  try {
    const manifestPath = join(work, latest.asset.name);
    await releases.download(latest.asset, manifestPath);
    const manifest = snapshotManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
    if (manifest.seq !== latest.seq || manifestName(manifest.seq) !== latest.asset.name) {
      throw new Error(`${latest.asset.name} describes snapshot ${manifest.seq}`);
    }
    const snapshot = assets.find((asset) => asset.name === manifest.snapshot.name);
    if (snapshot === undefined) {
      throw new Error(`${latest.asset.name} names ${manifest.snapshot.name}, which is missing`);
    }
    const snapshotPath = join(work, snapshot.name);
    await releases.download(snapshot, snapshotPath);
    await unpackSnapshot(snapshotPath, manifest, key, storePath);
    return { kind: "restored", seq: manifest.seq, assets };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function pack(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: { store: { type: "string" }, out: { type: "string" } },
    strict: true,
  });
  const storePath = requireOption(values.store, "--store");
  const out = requireOption(values.out, "--out");
  if (!(await exists(storePath))) throw new UsageError(`${storePath} does not exist`);
  const key = parseStoreKey(storeKey());
  const identity = runIdentity(Date.now());
  await mkdir(out, { recursive: true });
  const store = openPipelineStore(storePath);
  try {
    const { manifest } = await packSnapshot(store, { dir: out, runId: identity.runId, key });
    writeOut(
      `${JSON.stringify({
        seq: manifest.seq,
        manifest: manifestName(manifest.seq),
        snapshot: manifest.snapshot.name,
        bytes: manifest.snapshot.bytes,
        sqliteBytes: manifest.sqliteBytes,
      })}\n`,
    );
    return 0;
  } finally {
    store.close();
  }
}

async function verify(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: { store: { type: "string" } },
    strict: true,
  });
  const storePath = requireOption(values.store, "--store");
  if (!(await exists(storePath))) throw new UsageError(`${storePath} does not exist`);
  const report = inspectStore(storePath);
  writeOut(`${JSON.stringify(report, null, 2)}\n`);
  return report.integrity.length === 1 && report.integrity[0] === "ok" ? 0 : 1;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
