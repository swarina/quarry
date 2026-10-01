/**
 * Serves a built site for local checking. It sends the headers the real deployment will, so
 * what you see here behaves like production: a strict content security policy, and immutable
 * caching for the content-addressed index files.
 *
 * Usage: node apps/site/scripts/serve.ts [--dir <dist>] [--port <n>]
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: { dir: { type: "string", default: "apps/site/dist" }, port: { type: "string" } },
  strict: true,
});
const port = Number(values.port ?? 8787);

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/** No inline scripts, no third-party code, and nothing may frame the page. */
const POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");

const server = createServer((request, response) => {
  const path = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/");
  const relative = normalize(path).replace(/^(\.\.[/\\])+/, "");
  const file = join(values.dir, relative.endsWith("/") ? `${relative}index.html` : relative);
  void (async () => {
    try {
      const found = await stat(file);
      if (!found.isFile()) throw new Error("not a file");
      const immutable = relative.startsWith("/index/") && !relative.endsWith("manifest.json");
      response.writeHead(200, {
        "content-type": TYPES[extname(file)] ?? "application/octet-stream",
        "content-security-policy": POLICY,
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      });
      createReadStream(file).pipe(response);
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found\n");
    }
  })();
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Serving ${values.dir} on http://127.0.0.1:${port}\n`);
});
