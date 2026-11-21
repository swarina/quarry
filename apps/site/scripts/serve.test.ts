import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The server is run as a child process rather than imported, because what is being checked is
 * that the process survives. An unhandled rejection ends whichever process raises it, so in
 * process that would end the test worker instead of failing an assertion.
 */
let directory: string;
let child: ReturnType<typeof spawn>;
let origin: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "quarry-serve-"));
  await writeFile(join(directory, "index.html"), "<!doctype html><title>Quarry</title>");
  child = spawn(
    process.execPath,
    [join(import.meta.dirname, "serve.ts"), "--dir", directory, "--port", "0"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  // Port 0 asks the operating system for a free port, so the server reports which one it got.
  const port = await new Promise<string>((resolve, reject) => {
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      const found = /http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (found?.[1] !== undefined) resolve(found[1]);
    });
    child.once("exit", (code) => reject(new Error(`server exited with ${code}: ${out}`)));
    setTimeout(() => reject(new Error(`server did not report a port: ${out}`)), 15_000);
  });
  origin = `http://127.0.0.1:${port}`;
}, 20_000);

afterAll(async () => {
  child.kill("SIGKILL");
  await rm(directory, { recursive: true, force: true });
});

describe("the site dev server", () => {
  it("serves the page", async () => {
    expect((await fetch(`${origin}/`)).status).toBe(200);
  });

  it("survives a malformed percent escape", async () => {
    // One unauthenticated GET of a truncated escape used to end the process, because the
    // URIError from decodeURIComponent escaped the request handler as an unhandled rejection.
    expect((await fetch(`${origin}/%E0%A4%A`)).status).toBe(400);
    expect(child.exitCode).toBe(null);
    expect((await fetch(`${origin}/`)).status).toBe(200);
  });
});
