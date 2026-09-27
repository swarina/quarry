import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import { z } from "zod";

/** The GitHub release whose assets hold the pipeline store's snapshots (ADR-0006). */
export const STORE_RELEASE_TAG = "pipeline-store";

export interface ReleaseAsset {
  readonly id: number;
  readonly name: string;
  readonly size: number;
  /** Epoch milliseconds. */
  readonly createdAt: number;
}

export interface ReleaseAssets {
  /** The assets of the release with `tag`, or undefined when there is no such release. */
  list(tag: string): Promise<readonly ReleaseAsset[] | undefined>;
  download(asset: ReleaseAsset, destination: string): Promise<void>;
}

const release = z.looseObject({ id: z.int() });
const asset = z.looseObject({
  id: z.int(),
  name: z.string(),
  size: z.int().nonnegative(),
  created_at: z.iso.datetime(),
});

const PAGE_SIZE = 100;

/**
 * Reads release assets through the GitHub REST API with a token that only needs read access
 * to the repository's contents. Writing assets happens elsewhere, in a job that runs no
 * third-party code (ADR-0006).
 */
export function createReleaseAssets(options: {
  readonly token: string;
  readonly repository: string;
  readonly userAgent: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly apiUrl?: string;
}): ReleaseAssets {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const base = `${options.apiUrl ?? "https://api.github.com"}/repos/${options.repository}`;
  const headers = {
    authorization: `Bearer ${options.token}`,
    "user-agent": options.userAgent,
    "x-github-api-version": "2022-11-28",
  };

  async function get(url: string, accept: string): Promise<Response> {
    const response = await fetchImpl(url, { headers: { ...headers, accept } });
    return response;
  }

  async function json(url: string): Promise<unknown | undefined> {
    const response = await get(url, "application/vnd.github+json");
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`GitHub API ${url} returned ${response.status}`);
    return response.json();
  }

  return {
    async list(tag) {
      const found = await json(`${base}/releases/tags/${encodeURIComponent(tag)}`);
      if (found === undefined) return undefined;
      const { id } = release.parse(found);
      const assets: ReleaseAsset[] = [];
      for (let page = 1; ; page += 1) {
        const body = await json(`${base}/releases/${id}/assets?per_page=${PAGE_SIZE}&page=${page}`);
        const batch = z.array(asset).parse(body ?? []);
        assets.push(
          ...batch.map((entry) => ({
            id: entry.id,
            name: entry.name,
            size: entry.size,
            createdAt: Date.parse(entry.created_at),
          })),
        );
        if (batch.length < PAGE_SIZE) return assets;
      }
    },

    async download(target, destination) {
      const url = `${base}/releases/assets/${target.id}`;
      const response = await get(url, "application/octet-stream");
      if (!response.ok || response.body === null) {
        throw new Error(`Downloading ${target.name} returned ${response.status}`);
      }
      await pipeline(
        Readable.fromWeb(response.body as ReadableStream<Uint8Array>),
        createWriteStream(destination, { flags: "wx" }),
      );
    },
  };
}
