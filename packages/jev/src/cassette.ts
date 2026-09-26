import { contentHash } from "@quarry/domain";
import type { Fetch } from "@typesafe-ai/sdk";
import { z } from "zod";
import { CASSETTE_MISS_HEADER } from "./errors.ts";

/**
 * - `live`: always call the API and store nothing.
 * - `record`: replay a stored response when one matches, otherwise call the API and store it.
 * - `replay`: never touch the network; an unmatched request fails with `CASSETTE_MISS`.
 */
export type CassetteMode = "live" | "record" | "replay";

export const recordedExchangeSchema = z.object({
  request: z.object({
    method: z.string(),
    path: z.string(),
    body: z.unknown(),
  }),
  response: z.object({
    status: z.int(),
    headers: z.record(z.string(), z.string()),
    body: z.string(),
  }),
});

export type RecordedExchange = z.infer<typeof recordedExchangeSchema>;

export interface CassetteStore {
  get(key: string): Promise<RecordedExchange | undefined>;
  put(key: string, exchange: RecordedExchange): Promise<void>;
}

export interface CassetteFetchOptions {
  readonly mode: CassetteMode;
  readonly store: CassetteStore;
  /** Transport for requests that reach the network. Defaults to the global `fetch`. */
  readonly fetch?: Fetch;
}

/** Response headers worth keeping; everything else, including anything sensitive, is dropped. */
const RECORDED_RESPONSE_HEADERS = ["content-type", "x-typesafe-request-id"];

/**
 * A `fetch` that records and replays API exchanges, making tests deterministic and letting
 * analyses re-run without spending money. Exchanges are keyed by method, path, and the
 * canonical request body (which includes the model), never by headers, so credentials are
 * neither stored nor part of the key. Only successful responses are recorded.
 */
export function createCassetteFetch(options: CassetteFetchOptions): Fetch {
  const upstream: Fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  if (options.mode === "live") return upstream;
  const { mode, store } = options;

  return async (input, init) => {
    const request = describeRequest(input, init);
    const key = await contentHash(request);

    const recorded = await store.get(key);
    if (recorded) return toResponse(recorded);
    if (mode === "replay") return cassetteMiss();

    const response = await upstream(input, init);
    const exchange: RecordedExchange = {
      request,
      response: {
        status: response.status,
        headers: pickHeaders(response.headers),
        body: await response.text(),
      },
    };
    if (response.ok) await store.put(key, exchange);
    return toResponse(exchange);
  };
}

function describeRequest(
  input: string,
  init: RequestInit | undefined,
): RecordedExchange["request"] {
  const body = init?.body;
  if (body !== undefined && body !== null && typeof body !== "string") {
    throw new TypeError("The cassette transport only supports string request bodies");
  }
  return {
    method: init?.method ?? "GET",
    path: new URL(input).pathname,
    body: typeof body === "string" ? JSON.parse(body) : null,
  };
}

function pickHeaders(headers: Headers): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of RECORDED_RESPONSE_HEADERS) {
    const value = headers.get(name);
    if (value !== null) picked[name] = value;
  }
  return picked;
}

function toResponse(exchange: RecordedExchange): Response {
  const { status, headers, body } = exchange.response;
  return new Response(body, { status, headers });
}

function cassetteMiss(): Response {
  return new Response(
    JSON.stringify({ error: { message: "No recorded response matches this request" } }),
    {
      status: 404,
      headers: { "content-type": "application/json", [CASSETTE_MISS_HEADER]: "miss" },
    },
  );
}
