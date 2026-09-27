import { randomBytes } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manifestName, openPipelineStore, packSnapshot, storeSeq } from "@quarry/storage/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReleaseAsset, ReleaseAssets } from "../releases.ts";
import { parseSnapshotChoice, restoreSnapshot } from "./store.ts";

const KEY = new Uint8Array(randomBytes(32));

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "quarry-restore-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A release backed by files in a directory, as the commit job would have uploaded them. */
function fakeRelease(files: Record<string, string> | undefined): ReleaseAssets {
  const assets: ReleaseAsset[] = Object.keys(files ?? {}).map((name, index) => ({
    id: index + 1,
    name,
    size: 1,
    createdAt: Date.UTC(2026, 8, 27),
  }));
  return {
    list: async () => (files === undefined ? undefined : assets),
    download: async (asset, destination) => {
      const source = files?.[asset.name];
      if (source === undefined) throw new Error(`missing ${asset.name}`);
      await copyFile(source, destination);
    },
  };
}

/** Packs `count` snapshots of a small store and returns the files a release would hold. */
async function packed(count: number): Promise<Record<string, string>> {
  const out = join(dir, "out");
  await mkdir(out, { recursive: true });
  const store = openPipelineStore(join(dir, "live.sqlite"));
  const files: Record<string, string> = {};
  try {
    for (let run = 1; run <= count; run += 1) {
      const packedRun = await packSnapshot(store, { dir: out, runId: `gh-${run}-1`, key: KEY });
      files[manifestName(packedRun.manifest.seq)] = packedRun.manifestPath;
      files[packedRun.manifest.snapshot.name] = packedRun.snapshotPath;
    }
  } finally {
    store.close();
  }
  return files;
}

describe("restoreSnapshot", () => {
  it("restores the newest snapshot by default and lists the release's assets", async () => {
    const files = await packed(3);
    const destination = join(dir, "restored.sqlite");
    const result = await restoreSnapshot(fakeRelease(files), destination, KEY);
    expect(result.kind === "restored" && result.manifest.seq).toBe(3);
    expect(result.kind === "restored" && result.assets).toHaveLength(6);
    const restored = openPipelineStore(destination);
    expect(storeSeq(restored)).toBe(3);
    restored.close();
  });

  it("restores the oldest snapshot, or one by number", async () => {
    const files = await packed(3);
    const release = fakeRelease(files);
    const oldest = await restoreSnapshot(release, join(dir, "oldest.sqlite"), KEY, {
      choice: "oldest",
    });
    expect(oldest.kind === "restored" && oldest.manifest.seq).toBe(1);
    const second = await restoreSnapshot(release, join(dir, "second.sqlite"), KEY, { choice: 2 });
    expect(second.kind === "restored" && second.manifest.seq).toBe(2);
    const restored = openPipelineStore(join(dir, "second.sqlite"));
    expect(storeSeq(restored)).toBe(2);
    restored.close();
    await expect(
      restoreSnapshot(release, join(dir, "missing.sqlite"), KEY, { choice: 7 }),
    ).rejects.toThrow(/Snapshot 7 is not in the "pipeline-store" release, which holds 1, 2, 3/);
  });

  it("refuses to start empty unless asked, and only when there is no snapshot", async () => {
    const destination = join(dir, "new.sqlite");
    await expect(restoreSnapshot(fakeRelease(undefined), destination, KEY)).rejects.toThrow(
      /--bootstrap/,
    );
    await expect(restoreSnapshot(fakeRelease({}), destination, KEY)).rejects.toThrow(/--bootstrap/);
    expect(
      await restoreSnapshot(fakeRelease(undefined), destination, KEY, { bootstrap: true }),
    ).toEqual({ kind: "bootstrapped" });
    expect((await stat(destination)).size).toBeGreaterThan(0);

    const files = await packed(1);
    await expect(
      restoreSnapshot(fakeRelease(files), join(dir, "other.sqlite"), KEY, { bootstrap: true }),
    ).rejects.toThrow(/refusing to bootstrap/);
  });

  it("fails when the manifest's snapshot is missing from the release", async () => {
    const files = await packed(1);
    const withoutSnapshot = Object.fromEntries(
      Object.entries(files).filter(([name]) => name.startsWith("manifest-")),
    );
    await expect(
      restoreSnapshot(fakeRelease(withoutSnapshot), join(dir, "x.sqlite"), KEY),
    ).rejects.toThrow(/which is missing/);
  });
});

describe("parseSnapshotChoice", () => {
  it("accepts newest, oldest, and snapshot numbers, padded or not", () => {
    expect(parseSnapshotChoice("newest")).toBe("newest");
    expect(parseSnapshotChoice("oldest")).toBe("oldest");
    expect(parseSnapshotChoice("12")).toBe(12);
    expect(parseSnapshotChoice("00000012")).toBe(12);
  });

  it("rejects anything else", () => {
    for (const value of ["0", "-1", "1.5", "latest", "", "123456789"]) {
      expect(() => parseSnapshotChoice(value)).toThrow(/--snapshot must be/);
    }
  });
});
