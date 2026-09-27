import { manifestSeq, snapshotSeq } from "@quarry/storage/node";
import type { ReleaseAsset } from "./releases.ts";

export interface RetentionPolicy {
  /** The newest snapshots to keep, whatever their age. */
  readonly daily: number;
  /** Also keep the newest snapshot of each of this many most recent weeks. */
  readonly weekly: number;
}

/** 14 daily and 12 weekly snapshots (ADR-0006). */
export const SNAPSHOT_RETENTION: RetentionPolicy = { daily: 14, weekly: 12 };

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** A snapshot without a manifest is a failed commit once it is this old. */
const ORPHAN_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Names of release assets that retention no longer needs: manifests outside the policy with
 * the snapshots of the same sequence number, and snapshots that never got a manifest. The
 * newest manifest is always kept, and assets that are not snapshots or manifests are never
 * touched.
 */
export function prunableAssets(
  assets: readonly ReleaseAsset[],
  now: number,
  policy: RetentionPolicy = SNAPSHOT_RETENTION,
): string[] {
  const manifests = assets
    .flatMap((asset) => {
      const seq = manifestSeq(asset.name);
      return seq === undefined ? [] : [{ asset, seq }];
    })
    .sort((left, right) => right.seq - left.seq);

  const kept = new Set(manifests.slice(0, Math.max(1, policy.daily)).map((entry) => entry.seq));
  const weeksKept = new Set<number>();
  for (const entry of manifests) {
    const week = Math.floor(entry.asset.createdAt / WEEK_MS);
    if (weeksKept.has(week)) continue;
    if (weeksKept.size >= policy.weekly) break;
    weeksKept.add(week);
    kept.add(entry.seq);
  }

  const manifestSeqs = new Set(manifests.map((entry) => entry.seq));
  const prunable: string[] = [];
  for (const entry of manifests) {
    if (!kept.has(entry.seq)) prunable.push(entry.asset.name);
  }
  for (const asset of assets) {
    const seq = snapshotSeq(asset.name);
    if (seq === undefined || kept.has(seq)) continue;
    const orphan = !manifestSeqs.has(seq);
    if (!orphan || now - asset.createdAt >= ORPHAN_AFTER_MS) prunable.push(asset.name);
  }
  return prunable.sort();
}
