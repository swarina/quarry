import { createServer } from "node:http";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createCriteriaHandler } from "@quarry/criteria";
import {
  createStoreAnswerCache,
  createStoreBudgetStore,
  createStorePostingSource,
} from "@quarry/criteria/node";
import {
  createJevClient,
  createRateLimiter,
  createSpendLimit,
  formatUsd,
  JEV_MODEL,
} from "@quarry/jev";
import { createJsonlLedger } from "@quarry/jev/node";
import { serveStatic } from "@quarry/site/static";
import { openPipelineStore } from "@quarry/storage/node";
import { positiveNumber, requireOption, writeOut } from "../cli.ts";
import { criteriaSecret, jevKey } from "../config.ts";
import { createLogger } from "../log.ts";

export const SERVE_CRITERIA_HELP = `  serve-criteria           Serve the criterion path locally, for asking your own questions.
    --store <path>           Store to read postings and keep answers in (required)
    --site <dir>             Also serve a built site from here, on the same origin
    --port <n>               Port to listen on (default: 8788)
    --per-request-usd <n>    Most one request may spend (default: 0.10)
    --per-day-usd <n>        Most all requests may spend in a UTC day (default: 2.00)
    --ledger <path>          Append every request's cost here (default: <store dir>/ledger.jsonl)
`;

const DEFAULT_PORT = 8788;
const DEFAULT_PER_REQUEST_USD = 0.1;
const DEFAULT_PER_DAY_USD = 2;
const REQUESTS_PER_MINUTE = 300;
const CONCURRENCY = 6;

/**
 * Serves the criterion path on this machine, against a real store.
 *
 * This is a development server, not the deployment: the deployment is a Worker, whose entry is
 * the same `(Request) => Response` handler this calls. It exists so the path can be exercised
 * end to end against real postings, which is the only way to find out whether asking your own
 * question is actually pleasant to use.
 *
 * With `--site` it also serves the built site, which is how the browser is meant to reach this:
 * the page and the criterion path on one origin, so there is no CORS policy to get wrong on an
 * endpoint that spends money, and the page's own `connect-src 'self'` is enough (ADR-0028).
 */
export async function serveCriteriaCommand(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      store: { type: "string" },
      site: { type: "string" },
      port: { type: "string" },
      "per-request-usd": { type: "string" },
      "per-day-usd": { type: "string" },
      ledger: { type: "string" },
    },
    strict: true,
  });
  const storePath = requireOption(values.store, "--store");
  const port = positiveNumber(values.port ?? String(DEFAULT_PORT), "--port");
  const perRequestUsd = positiveNumber(
    values["per-request-usd"] ?? String(DEFAULT_PER_REQUEST_USD),
    "--per-request-usd",
  );
  const perDayUsd = positiveNumber(
    values["per-day-usd"] ?? String(DEFAULT_PER_DAY_USD),
    "--per-day-usd",
  );

  const secret = criteriaSecret();
  const apiKey = jevKey();
  const log = createLogger("criteria", writeOut);
  const store = openPipelineStore(storePath);
  const ledger = createJsonlLedger(values.ledger ?? join(storePath, "..", "ledger.jsonl"));
  // One limiter for the process: every request shares the account's rate.
  const rateLimiter = createRateLimiter({
    requestsPerMinute: REQUESTS_PER_MINUTE,
    maxConcurrent: CONCURRENCY,
  });

  const handler = createCriteriaHandler({
    secret,
    model: JEV_MODEL,
    postings: createStorePostingSource(store),
    cache: createStoreAnswerCache(store),
    budget: createStoreBudgetStore(store),
    limits: {
      perRequestNanoUsd: Math.round(perRequestUsd * 1e9),
      perDayNanoUsd: Math.round(perDayUsd * 1e9),
    },
    // A client per request, with its spend limit set to that request's allowance: this is what
    // makes the cap exact rather than an estimate (ADR-0005).
    client: (allowanceNanoUsd) =>
      createJevClient({
        apiKey,
        ledger,
        rateLimiter,
        spendLimit: createSpendLimit({ limitNanoUsd: allowanceNanoUsd }),
      }),
    concurrency: CONCURRENCY,
  });

  const site = values.site;

  const server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      void (async () => {
        const method = incoming.method ?? "GET";
        const path = incoming.url ?? "/";
        // The site is served only off the criterion path's own routes, so a file can never
        // shadow one of them: `/criteria/ask` is answered by the handler whatever is on disk.
        if (site !== undefined && !path.startsWith("/criteria/")) {
          if (await serveStatic(site, path, outgoing)) return;
          outgoing.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          outgoing.end("Not found\n");
          return;
        }
        const request = new Request(`http://localhost:${port}${path}`, {
          method,
          headers: Object.entries(incoming.headers).flatMap(([name, value]) =>
            value === undefined ? [] : [[name, Array.isArray(value) ? value.join(", ") : value]],
          ) as [string, string][],
          ...(method === "GET" || method === "HEAD" ? {} : { body: Buffer.concat(chunks) }),
        });
        try {
          const response = await handler(request);
          const body = await response.text();
          outgoing.writeHead(response.status, Object.fromEntries(response.headers));
          outgoing.end(body);
          log.info("criterion request", {
            method,
            path: new URL(request.url).pathname,
            status: response.status,
          });
        } catch (error) {
          // The handler answers a bad request itself, so reaching here is a fault in our code.
          log.error("criterion request failed", {
            error_message: error instanceof Error ? error.message : String(error),
          });
          outgoing.writeHead(500, { "content-type": "application/json; charset=utf-8" });
          outgoing.end(`${JSON.stringify({ error: { code: "INTERNAL", message: "failed" } })}\n`);
        }
      })();
    });
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  writeOut(
    `Serving the criterion path on http://127.0.0.1:${port}\n` +
      (site === undefined ? "" : `  the site from ${site}, on this same origin\n`) +
      `  POST /criteria/estimate   what asking would cost, spending nothing\n` +
      `  POST /criteria/ask        answer, up to ${formatUsd(Math.round(perRequestUsd * 1e9))} per request\n` +
      `  a day's spending is capped at ${formatUsd(Math.round(perDayUsd * 1e9))}\n` +
      "  both need: Authorization: Bearer $QUARRY_CRITERIA_SECRET\n",
  );

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      server.close(() => resolve());
      store.close();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}
