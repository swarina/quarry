import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RecordedExchange } from "../cassette.ts";
import { createFileCassetteStore } from "./file-cassette-store.ts";

const exchange: RecordedExchange = {
  request: { method: "POST", path: "/v1/systemone", body: { state: "hello" } },
  response: { status: 200, headers: { "content-type": "application/json" }, body: "{}" },
};

describe("createFileCassetteStore", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "quarry-cassettes-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("round-trips an exchange through a JSON file named by its key", async () => {
    const store = createFileCassetteStore(join(directory, "nested"));
    await store.put("abc123", exchange);

    expect(await store.get("abc123")).toEqual(exchange);
    expect(await readdir(join(directory, "nested"))).toEqual(["abc123.json"]);
  });

  it("returns undefined for a key that was never recorded", async () => {
    expect(await createFileCassetteStore(directory).get("missing")).toBeUndefined();
  });

  it("rejects a corrupted cassette file", async () => {
    await writeFile(join(directory, "bad.json"), JSON.stringify({ request: {} }));
    await expect(createFileCassetteStore(directory).get("bad")).rejects.toThrow();
  });
});
