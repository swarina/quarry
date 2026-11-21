/**
 * Serves a built site for local checking. It sends the headers the real deployment will, so
 * what you see here behaves like production: a strict content security policy, and immutable
 * caching for the content-addressed index files.
 *
 * This serves search alone. To exercise asking your own questions, serve the same directory
 * beside the criterion path instead, with `pipeline serve-criteria --site <dist>`: the page's
 * policy allows it to call back only to the origin it came from (ADR-0028).
 *
 * Usage: node apps/site/scripts/serve.ts [--dir <dist>] [--port <n>]
 */
import { createServer } from "node:http";
import { parseArgs } from "node:util";
import { serveStatic } from "./static.ts";

const { values } = parseArgs({
  options: { dir: { type: "string", default: "apps/site/dist" }, port: { type: "string" } },
  strict: true,
});
const port = Number(values.port ?? 8787);

const server = createServer((request, response) => {
  void (async () => {
    if (await serveStatic(values.dir, request.url ?? "/", response)) return;
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found\n");
  })().catch((error: unknown) => {
    // Without this, anything that throws here is an unhandled rejection and the process exits,
    // so one bad request ends the server for everyone. Answer and stay up instead.
    process.stderr.write(`Request failed: ${error instanceof Error ? error.message : error}\n`);
    if (!response.headersSent) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    }
    response.end();
  });
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const bound = typeof address === "object" && address !== null ? address.port : port;
  process.stdout.write(`Serving ${values.dir} on http://127.0.0.1:${bound}\n`);
});
