import type { EntryType, Fetch, Questions, SystemOneResult } from "@typesafe-ai/sdk";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { z } from "zod";
import { JevError, toJevError } from "./errors.ts";
import type { Ledger } from "./ledger.ts";
import { costNanoUsd, JEV_MODEL } from "./model.ts";
import { assertValidQuestions } from "./questions.ts";
import type { RateLimiter } from "./rate-limiter.ts";
import { responseSchema } from "./response-schema.ts";
import type { SpendLimit } from "./spend-limit.ts";

const DEFAULT_BASE_URL = "https://api.typesafe.ai";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 2;

export interface JevClientOptions {
  readonly apiKey: string;
  /** Override only to evaluate a candidate version against the pinned one. */
  readonly model?: string;
  readonly baseUrl?: string;
  /** Transport, for example a cassette `fetch`. Defaults to the global `fetch`. */
  readonly fetch?: Fetch;
  /** Timeout per attempt. Defaults to 15 seconds. */
  readonly timeoutMs?: number;
  /** Retries for 408, 429, 5xx, timeouts, and connection errors. Defaults to 2. */
  readonly maxRetries?: number;
  readonly rateLimiter?: RateLimiter;
  readonly spendLimit?: SpendLimit;
  readonly ledger?: Ledger;
  /** Clock in milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
}

export interface AskRequest<Q extends Questions> {
  /** Short label recorded in the ledger, for example "enrichment" or "criterion". */
  readonly purpose: string;
  readonly state: EntryType;
  readonly questions: Q;
  readonly signal?: AbortSignal;
}

export interface AskUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costNanoUsd: number;
}

export interface AskResult<Q extends Questions> {
  readonly model: string;
  readonly answers: SystemOneResult<Q>["answers"];
  readonly usage: AskUsage;
  readonly requestId: string | undefined;
  readonly latencyMs: number;
}

export interface JevClient {
  /** The model version every request is sent to. */
  readonly model: string;
  /**
   * Asks every question about one state in a single request. Throws a `JevError` on any
   * failure, including answers that do not match the questions or come from another model.
   */
  ask<const Q extends Questions>(request: AskRequest<Q>): Promise<AskResult<Q>>;
}

const encoder = new TextEncoder();

export function createJevClient(options: JevClientOptions): JevClient {
  const model = options.model ?? JEV_MODEL;
  const now = options.now ?? Date.now;
  const sdk = new TypeSafeClient({
    apiKey: options.apiKey,
    baseURL: options.baseUrl ?? DEFAULT_BASE_URL,
    defaultModel: model,
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    retry: { maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES },
    logLevel: "off",
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  async function ask<const Q extends Questions>(request: AskRequest<Q>): Promise<AskResult<Q>> {
    assertValidQuestions(request.questions);
    const payload = { state: request.state, questions: request.questions, model };

    // A token never covers less than one byte, so the UTF-8 size bounds the billable tokens.
    const upperBound = costNanoUsd(encoder.encode(JSON.stringify(payload)).length);
    const reservation = options.spendLimit?.reserve(upperBound);

    let releaseSlot: (() => void) | undefined;
    let sentAt: number | undefined;
    try {
      releaseSlot = await options.rateLimiter?.acquire(request.signal);
      sentAt = now();
      const call = sdk.systemOne(payload, request.signal ? { signal: request.signal } : {});
      const { data, requestId } = await call.withResponse();
      const latencyMs = now() - sentAt;

      const response = parseResponse(data, request.questions, model, requestId);
      const usage: AskUsage = {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        costNanoUsd: costNanoUsd(response.usage.input_tokens),
      };
      reservation?.settle(usage.costNanoUsd);
      await options.ledger?.record({
        at: sentAt,
        purpose: request.purpose,
        model,
        status: "ok",
        ...usage,
        latencyMs,
        ...(requestId ? { requestId } : {}),
      });

      return {
        model: response.model,
        // The schema was derived from `request.questions`, the same source the SDK derives
        // these answer types from, so the validated value has exactly this shape.
        answers: response.answers as unknown as SystemOneResult<Q>["answers"],
        usage,
        requestId,
        latencyMs,
      };
    } catch (error) {
      reservation?.release();
      const failure = toJevError(error);
      if (sentAt !== undefined) {
        await recordFailure(options.ledger, failure, request.purpose, model, sentAt, now());
      }
      throw failure;
    } finally {
      releaseSlot?.();
    }
  }

  return { model, ask };
}

function parseResponse(
  data: unknown,
  questions: Questions,
  model: string,
  requestId: string | undefined,
) {
  const result = responseSchema(questions).safeParse(data);
  if (!result.success) {
    throw new JevError(
      "INVALID_RESPONSE",
      `The response does not match the questions:\n${z.prettifyError(result.error)}`,
      { requestId },
    );
  }
  if (result.data.model !== model) {
    throw new JevError(
      "MODEL_MISMATCH",
      `Expected answers from ${model}, but ${result.data.model} responded`,
      { requestId },
    );
  }
  return result.data;
}

/**
 * Records a failed call. A failure costs nothing, so if the ledger itself fails here we keep
 * the original error, which is the one the caller can act on.
 */
async function recordFailure(
  ledger: Ledger | undefined,
  failure: JevError,
  purpose: string,
  model: string,
  sentAt: number,
  finishedAt: number,
): Promise<void> {
  try {
    await ledger?.record({
      at: sentAt,
      purpose,
      model,
      status: "error",
      errorCode: failure.code,
      inputTokens: 0,
      outputTokens: 0,
      costNanoUsd: 0,
      latencyMs: finishedAt - sentAt,
      ...(failure.requestId ? { requestId: failure.requestId } : {}),
    });
  } catch {
    // Intentionally ignored: see the function comment.
  }
}
