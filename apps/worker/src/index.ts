/**
 * The Worker entry point.
 *
 * `run_worker_first` in `wrangler.toml` sends only `/criteria/ask` and `/criteria/estimate` here;
 * every other path is served as a static file by the platform, with the security headers from the
 * site's own `_headers` file (ADR-0028). The handler is the same `(Request) => Response` the dev
 * server runs (ADR-0027), with the three ports backed by D1 (ADR-0029). Anything else that reaches
 * the Worker is handed to the static assets, so the two never fight over a path.
 */
import { createCriteriaHandler } from "@quarry/criteria";
import { createJevClient, createRateLimiter, createSpendLimit, JEV_MODEL } from "@quarry/jev";
import {
  createD1AnswerCache,
  createD1BudgetStore,
  createD1PostingSource,
  type D1Database,
} from "./d1.ts";

interface Env {
  readonly DB: D1Database;
  readonly ASSETS: { fetch(request: Request): Promise<Response> };
  readonly QUARRY_CRITERIA_SECRET: string;
  readonly TYPESAFE_API_KEY: string;
  readonly QUARRY_CRITERIA_PER_REQUEST_NANO_USD?: string;
  readonly QUARRY_CRITERIA_PER_DAY_NANO_USD?: string;
}

// The account's rate is shared across requests handled by this isolate, as it is in the dev server.
const rateLimiter = createRateLimiter({ requestsPerMinute: 300, maxConcurrent: 6 });

function nanoUsd(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// A module-format Cloudflare Worker is defined by its default export, so this one is required.
// biome-ignore lint/style/noDefaultExport: Cloudflare Workers are entered through the default export.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname !== "/criteria/ask" && pathname !== "/criteria/estimate") {
      return env.ASSETS.fetch(request);
    }

    const handler = createCriteriaHandler({
      secret: env.QUARRY_CRITERIA_SECRET,
      model: JEV_MODEL,
      postings: createD1PostingSource(env.DB),
      cache: createD1AnswerCache(env.DB),
      budget: createD1BudgetStore(env.DB),
      limits: {
        perRequestNanoUsd: nanoUsd(env.QUARRY_CRITERIA_PER_REQUEST_NANO_USD, 100_000_000),
        perDayNanoUsd: nanoUsd(env.QUARRY_CRITERIA_PER_DAY_NANO_USD, 2_000_000_000),
      },
      // A client per request, its spend limit set to the request's allowance, which is what makes
      // the per-request cap exact (ADR-0005). The client runs on the Worker's global fetch.
      client: (allowanceNanoUsd) =>
        createJevClient({
          apiKey: env.TYPESAFE_API_KEY,
          rateLimiter,
          spendLimit: createSpendLimit({ limitNanoUsd: allowanceNanoUsd }),
        }),
    });

    return handler(request);
  },
};
