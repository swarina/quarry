import { manifestName, snapshotName } from "@quarry/storage/node";
import { describe, expect, it } from "vitest";
import type { ReleaseAsset } from "./releases.ts";
import { prunableAssets } from "./retention.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 11, 31, 4);

/** One committed snapshot per day for `days` days, the newest yesterday. */
function dailySnapshots(days: number): ReleaseAsset[] {
  const assets: ReleaseAsset[] = [];
  for (let seq = 1; seq <= days; seq += 1) {
    const createdAt = NOW - (days - seq + 1) * DAY;
    assets.push({ id: seq * 2, name: manifestName(seq), size: 400, createdAt });
    assets.push({ id: seq * 2 + 1, name: snapshotName(seq, `gh-${seq}-1`), size: 9, createdAt });
  }
  return assets;
}

const kept = (assets: ReleaseAsset[], pruned: string[]) =>
  assets.map((asset) => asset.name).filter((name) => !pruned.includes(name));

describe("prunableAssets", () => {
  it("keeps everything while within the daily window", () => {
    expect(prunableAssets(dailySnapshots(14), NOW)).toEqual([]);
  });

  it("keeps 14 daily snapshots plus one per week for 12 weeks", () => {
    const assets = dailySnapshots(200);
    const pruned = prunableAssets(assets, NOW);
    const manifests = kept(assets, pruned).filter((name) => name.startsWith("manifest-"));
    // The 14 newest overlap the two newest weeks, so 14 + 10 older weekly ones remain.
    expect(manifests.length).toBeGreaterThanOrEqual(14 + 10);
    expect(manifests.length).toBeLessThanOrEqual(14 + 12);
    expect(manifests).toContain(manifestName(200));
    expect(manifests).not.toContain(manifestName(1));
  });

  it("deletes a pruned manifest together with its snapshot", () => {
    const pruned = prunableAssets(dailySnapshots(60), NOW, { daily: 2, weekly: 0 });
    expect(pruned).toContain(manifestName(1));
    expect(pruned).toContain(snapshotName(1, "gh-1-1"));
    expect(pruned).not.toContain(manifestName(60));
    expect(pruned).not.toContain(snapshotName(60, "gh-60-1"));
  });

  it("always keeps the newest manifest, even with an empty policy", () => {
    const pruned = prunableAssets(dailySnapshots(3), NOW, { daily: 0, weekly: 0 });
    expect(pruned).not.toContain(manifestName(3));
    expect(pruned).toContain(manifestName(1));
  });

  it("deletes snapshots that never got a manifest once they are a day old", () => {
    const assets = [
      ...dailySnapshots(3),
      { id: 90, name: snapshotName(4, "gh-lost-1"), size: 9, createdAt: NOW - 2 * DAY },
      { id: 91, name: snapshotName(5, "gh-now-1"), size: 9, createdAt: NOW - 60_000 },
    ];
    const pruned = prunableAssets(assets, NOW);
    expect(pruned).toEqual([snapshotName(4, "gh-lost-1")]);
  });

  it("never touches assets it does not recognize", () => {
    const assets = [...dailySnapshots(30), { id: 99, name: "README.txt", size: 1, createdAt: 0 }];
    expect(prunableAssets(assets, NOW, { daily: 1, weekly: 0 })).not.toContain("README.txt");
  });
});
