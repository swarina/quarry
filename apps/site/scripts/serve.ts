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
  })();
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Serving ${values.dir} on http://127.0.0.1:${port}\n`);
});
