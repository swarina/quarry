import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POLICY, renderHeadersFile, SECURITY_HEADERS, serveStatic } from "./static.ts";

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
    })().catch(() => {
      // The same boundary catch the real servers have. Without it a throw in here is an
      // unhandled rejection, which ends the test worker instead of failing one assertion.
      if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain" });
      response.end();
    });
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

  it("answers a malformed percent escape with 400 and keeps serving", async () => {
    // `%E0%A4%A` is a truncated escape, so decodeURIComponent throws. Unguarded that throw left
    // the request handler as an unhandled rejection and ended the process: one GET, no payload,
    // no authentication, server gone until restarted.
    const response = await fetch(`${origin}/%E0%A4%A`);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Bad request");
    expect((await fetch(`${origin}/`)).status).toBe(200);
  });

  it("sends the security headers even on a malformed path", async () => {
    // A path we refuse is still a response from this origin, so it carries the same policy.
    const response = await fetch(`${origin}/%ZZ`);
    expect(response.status).toBe(400);
    expect(response.headers.get("content-security-policy")).toBe(POLICY);
  });

  it("reports a malformed path as answered, not as a miss", async () => {
    // serveStatic returning false means "no such file", which each caller turns into its own
    // 404. A path that cannot be decoded is answered here, so it must not come back as false.
    const written: number[] = [];
    const stub = {
      headersSent: false,
      writeHead(status: number) {
        written.push(status);
        return this;
      },
      end() {
        return this;
      },
    };
    await expect(
      serveStatic(directory, "/%E0%A4%A", stub as unknown as ServerResponse),
    ).resolves.toBe(true);
    expect(written).toEqual([400]);
  });
});

describe("the _headers file for a deployment", () => {
  it("carries the same security headers the dev server sends", () => {
    // The whole point of one source is that production and development cannot disagree about the
    // policy that keeps the page same-origin (ADR-0028).
    const rendered = renderHeadersFile();
    expect(rendered).toContain("/*");
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(rendered).toContain(`${name}: ${value}`);
    }
    expect(rendered).toContain(`content-security-policy: ${POLICY}`);
  });

  it("marks the content-addressed index files immutable, and nothing else", () => {
    const rendered = renderHeadersFile();
    expect(rendered).toContain("/index/:build/shards/*");
    expect(rendered).toMatch(/max-age=31536000, immutable/);
    // The manifest names the build, so it must stay revalidated; it gets no immutable rule.
    expect(rendered).not.toContain("/index/manifest.json");
  });

  it("uses at most one wildcard per rule, which is all Cloudflare _headers allows", () => {
    // wrangler rejects a rule with two `*` and skips it, so a two-wildcard cache rule would
    // silently not apply. The build segment is a named placeholder instead.
    for (const line of renderHeadersFile().split("\n")) {
      if (line.startsWith("/")) expect((line.match(/\*/g) ?? []).length).toBeLessThanOrEqual(1);
    }
  });
});

describe("the types robots.txt and sitemap.xml are served with", () => {
  it("serves a .txt file as plain text", async () => {
    // `nosniff` means a browser will not guess past a wrong type, and a crawler handed
    // application/octet-stream for robots.txt has no reason to read it as a policy.
    await writeFile(join(directory, "robots.txt"), "User-agent: *\nAllow: /\n");
    const response = await fetch(`${origin}/robots.txt`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("serves a .xml file as XML", async () => {
    await writeFile(join(directory, "sitemap.xml"), "<urlset></urlset>\n");
    const response = await fetch(`${origin}/sitemap.xml`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/xml; charset=utf-8");
  });
});
