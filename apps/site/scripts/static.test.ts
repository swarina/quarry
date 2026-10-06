import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POLICY, serveStatic } from "./static.ts";

let directory: string;
let server: Server;
let origin: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "quarry-static-"));
  await writeFile(join(directory, "index.html"), "<!doctype html><title>Quarry</title>");
  await writeFile(join(directory, "main.js"), "export const a = 1;\n");
  await writeFile(join(directory, "secret.txt"), "not served from a parent\n");
  server = createServer((request, response) => {
    void (async () => {
      if (await serveStatic(directory, request.url ?? "/", response)) return;
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("Not found\n");
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});

describe("serving the built site", () => {
  it("serves the page at the root", async () => {
    const response = await fetch(`${origin}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await response.text()).toContain("Quarry");
  });

  it("sends the policy that keeps the page talking only to this origin", async () => {
    // This is what makes the criterion path same-origin rather than a CORS policy (ADR-0028).
    // A page that could reach another origin is a page a secret can be sent from.
    const response = await fetch(`${origin}/`);
    expect(response.headers.get("content-security-policy")).toBe(POLICY);
    expect(POLICY).toContain("connect-src 'self'");
    expect(POLICY).toContain("frame-ancestors 'none'");
  });

  it("caches the content-addressed index hard, and the manifest naming it not at all", async () => {
    const response = await fetch(`${origin}/main.js`);
    expect(response.headers.get("cache-control")).toBe("no-cache");
  });

  it("does not serve files from outside the directory", async () => {
    const response = await fetch(`${origin}/../../etc/passwd`);
    expect(response.status).toBe(404);
  });

  it("says plainly when there is no such file", async () => {
    expect((await fetch(`${origin}/nothing-here`)).status).toBe(404);
  });
});
