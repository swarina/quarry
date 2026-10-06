import type { JevClient } from "@quarry/jev";
import { askCriteria, estimateAsk } from "./ask.ts";
import {
  type BudgetLimits,
  type BudgetStore,
  reserveAllowance,
  settleAllowance,
} from "./budget.ts";
import { type Criterion, CriterionError, readCriteria } from "./criterion.ts";
import type { AnswerCache, PostingSource } from "./ports.ts";

/**
 * The request path for asking your own questions.
 *
 * A plain `(Request) => Response` function, which is a Cloudflare Worker's own entry shape and
 * also a thing a Node server can call, so the whole path is testable without a deployment.
 * Everything environment-shaped arrives through the ports.
 */

export interface CriteriaHandlerOptions {
  /**
   * The secret a caller must present. Asking spends money, so the endpoint is closed even
   * though search itself is public static files.
   */
  readonly secret: string;
  readonly postings: PostingSource;
  readonly cache: AnswerCache;
  readonly budget: BudgetStore;
  readonly limits: BudgetLimits;
  /**
   * Builds the client for one request, with its spend limit set to the allowance.
   *
   * A factory rather than a client, because the spend limit is what makes the cap exact
   * (ADR-0005) and it has to be scoped to this request's allowance. The ask loop's own estimate
   * only decides how many requests to start.
   */
  readonly client: (allowanceNanoUsd: number) => JevClient;
  readonly maxCriteria?: number;
  readonly maxPostings?: number;
  readonly concurrency?: number;
  /** How long a request may spend asking before it reports what it has. */
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

/** Criteria per request. More than a handful is a different product, not a bigger request. */
const MAX_CRITERIA = 5;
/**
 * Postings per request. The point of asking only what the filters leave is that this is a page
 * of results, not the corpus; a request naming more than this has not filtered.
 */
const MAX_POSTINGS = 500;
const CONCURRENCY = 6;
const TIMEOUT_MS = 20_000;

function json(body: unknown, status = 200): Response {
  return new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Nothing here is cacheable by a shared cache: it is answers, behind a secret.
      "cache-control": "no-store",
    },
  });
}

function failure(code: string, message: string, status: number): Response {
  return json({ error: { code, message } }, status);
}

/**
 * Compares two secrets without revealing where they first differ through timing.
 *
 * Written by hand because this has to run on a Worker, where `node:crypto`'s
 * `timingSafeEqual` is not available and WebCrypto offers no equivalent. Lengths are compared
 * by accumulating rather than returning early, so a wrong length costs the same as a wrong
 * character.
 */
function secretsMatch(given: string, expected: string): boolean {
  const length = Math.max(given.length, expected.length);
  let difference = given.length ^ expected.length;
  for (let at = 0; at < length; at += 1) {
    difference |= (given.charCodeAt(at) || 0) ^ (expected.charCodeAt(at) || 0);
  }
  return difference === 0;
}

/** The bearer token a request presented, or undefined. */
function bearer(request: Request): string | undefined {
  const header = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  return header.startsWith(prefix) ? header.slice(prefix.length) : undefined;
}

interface AskBody {
  readonly criteria: readonly Criterion[];
  readonly idPrefixes: readonly string[];
}

/** Reads and checks a request body, or throws a `CriterionError` naming what is wrong. */
async function readBody(
  request: Request,
  maxCriteria: number,
  maxPostings: number,
): Promise<AskBody> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new CriterionError("body is not JSON");
  }
  if (parsed === null || typeof parsed !== "object")
    throw new CriterionError("body is not an object");
  const given = parsed as Record<string, unknown>;
  const criteria = await readCriteria(given["criteria"], maxCriteria);

  const postings = given["postings"];
  if (!Array.isArray(postings)) throw new CriterionError("postings is not a list");
  if (postings.length === 0) throw new CriterionError("no postings given");
  if (postings.length > maxPostings) {
    throw new CriterionError(`at most ${maxPostings} postings at a time; filter further first`);
  }
  const idPrefixes = postings.map((entry, at) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new CriterionError(`postings[${at}] is not a posting id`);
    }
    return entry.trim();
  });
  return { criteria, idPrefixes };
}

/** How a criterion is described back to the caller, so it can label what it shows. */
function describe(criterion: Criterion) {
  return {
    id: criterion.id,
    kind: criterion.kind,
    options: criterion.options,
    labels: criterion.labels,
  };
}

/**
 * Builds the handler. Two routes:
 *
 * - `POST /criteria/estimate` says what asking would cost and how much is already cached,
 *   spending nothing, so a caller can show the price before committing to it.
 * - `POST /criteria/ask` answers, within this request's allowance.
 */
export function createCriteriaHandler(
  options: CriteriaHandlerOptions,
): (request: Request) => Promise<Response> {
  const now = options.now ?? Date.now;
  const maxCriteria = options.maxCriteria ?? MAX_CRITERIA;
  const maxPostings = options.maxPostings ?? MAX_POSTINGS;

  return async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    if (pathname !== "/criteria/ask" && pathname !== "/criteria/estimate") {
      return failure("NOT_FOUND", "no such route", 404);
    }
    if (request.method !== "POST") {
      return new Response(null, { status: 405, headers: { allow: "POST" } });
    }

    const given = bearer(request);
    if (given === undefined || !secretsMatch(given, options.secret)) {
      // The same answer either way: whether a token was presented is not worth telling.
      return failure("UNAUTHORIZED", "a bearer token is required", 401);
    }

    let body: AskBody;
    try {
      body = await readBody(request, maxCriteria, maxPostings);
    } catch (caught) {
      if (caught instanceof CriterionError) return failure("BAD_REQUEST", caught.message, 400);
      throw caught;
    }

    if (pathname === "/criteria/estimate") {
      // No allowance is reserved: estimating spends nothing, so it must not consume the day.
      const estimate = await estimateAsk({
        criteria: body.criteria,
        idPrefixes: body.idPrefixes,
        postings: options.postings,
        cache: options.cache,
        model: options.client(0).model,
      });
      return json({
        criteria: body.criteria.map(describe),
        estimate,
        limits: {
          perRequestNanoUsd: options.limits.perRequestNanoUsd,
          perDayNanoUsd: options.limits.perDayNanoUsd,
          committedTodayNanoUsd: await options.budget.committed(
            new Date(now()).toISOString().slice(0, 10),
          ),
        },
      });
    }

    const allowance = await reserveAllowance(options.budget, options.limits, now());
    if (allowance.nanoUsd === 0) {
      return failure("BUDGET_SPENT", "today's budget is spent; it resets at midnight UTC", 429);
    }

    try {
      const result = await askCriteria({
        criteria: body.criteria,
        idPrefixes: body.idPrefixes,
        postings: options.postings,
        cache: options.cache,
        // The spend limit inside this client is what makes the allowance exact.
        client: options.client(allowance.nanoUsd),
        allowanceNanoUsd: allowance.nanoUsd,
        deadline: now() + (options.timeoutMs ?? TIMEOUT_MS),
        concurrency: options.concurrency ?? CONCURRENCY,
        now,
      });
      await settleAllowance(options.budget, allowance, result.report.costNanoUsd);
      return json({
        criteria: body.criteria.map(describe),
        answers: result.answers,
        report: result.report,
        budget: {
          allowanceNanoUsd: allowance.nanoUsd,
          limitedByDay: allowance.limitedByDay,
        },
      });
    } catch (caught) {
      // Whatever went wrong, the day gets its reservation back: a failed request that keeps the
      // allowance would eat the daily cap a little at a time.
      await settleAllowance(options.budget, allowance, 0);
      throw caught;
    }
  };
}
