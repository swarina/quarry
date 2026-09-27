import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReleaseAssets } from "./releases.ts";

const API = "https://api.github.test/repos/acme/quarry";

function server(routes: Record<string, () => Response>) {
  const requests: { url: string; headers: Headers }[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push({ url: request.url, headers: request.headers });
    const route = routes[request.url];
    return route === undefined ? new Response("not found", { status: 404 }) : route();
  };
  const releases = createReleaseAssets({
    token: "test-token",
    repository: "acme/quarry",
    userAgent: "QuarryBot/test",
    fetch: fetch as typeof globalThis.fetch,
    apiUrl: "https://api.github.test",
  });
  return { releases, requests };
}

const asset = (id: number, name: string) => ({
  id,
  name,
  size: 10,
  created_at: "2026-09-27T03:40:00Z",
  uploader: { login: "github-actions[bot]" },
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "quarry-releases-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("createReleaseAssets", () => {
  it("returns undefined when the release does not exist", async () => {
    const { releases } = server({});
    expect(await releases.list("pipeline-store")).toBeUndefined();
  });

  it("lists every page of assets and authenticates each request", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => asset(index + 1, `a-${index}`));
    const { releases, requests } = server({
      [`${API}/releases/tags/pipeline-store`]: () =>
        Response.json({ id: 7, tag_name: "pipeline-store" }),
      [`${API}/releases/7/assets?per_page=100&page=1`]: () => Response.json(firstPage),
      [`${API}/releases/7/assets?per_page=100&page=2`]: () => Response.json([asset(101, "last")]),
    });
    const assets = await releases.list("pipeline-store");
    expect(assets).toHaveLength(101);
    expect(assets?.[100]).toEqual({
      id: 101,
      name: "last",
      size: 10,
      createdAt: Date.UTC(2026, 8, 27, 3, 40),
    });
    for (const request of requests) {
      expect(request.headers.get("authorization")).toBe("Bearer test-token");
      expect(request.headers.get("user-agent")).toBe("QuarryBot/test");
    }
  });

  it("fails loudly on API errors and malformed responses", async () => {
    const broken = server({ [`${API}/releases/tags/x`]: () => new Response("", { status: 500 }) });
    await expect(broken.releases.list("x")).rejects.toThrow(/returned 500/);
    const malformed = server({
      [`${API}/releases/tags/x`]: () => Response.json({ id: 1 }),
      [`${API}/releases/1/assets?per_page=100&page=1`]: () => Response.json([{ id: "one" }]),
    });
    await expect(malformed.releases.list("x")).rejects.toThrow();
  });

  it("downloads an asset's bytes to a new file", async () => {
    const { releases, requests } = server({
      [`${API}/releases/assets/5`]: () => new Response("snapshot bytes"),
    });
    const destination = join(dir, "file");
    await releases.download({ id: 5, name: "file", size: 14, createdAt: 0 }, destination);
    expect(await readFile(destination, "utf8")).toBe("snapshot bytes");
    expect(requests[0]?.headers.get("accept")).toBe("application/octet-stream");
    await expect(
      releases.download({ id: 5, name: "file", size: 14, createdAt: 0 }, destination),
    ).rejects.toThrow();
    await expect(
      releases.download({ id: 6, name: "gone", size: 1, createdAt: 0 }, join(dir, "gone")),
    ).rejects.toThrow(/returned 404/);
  });
});
