import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  PermissionDeniedError,
  RateLimitError,
  UnprocessableEntityError,
} from "@typesafe-ai/sdk";

export const JEV_ERROR_CODES = [
  "ABORTED",
  "AUTHENTICATION",
  "BUDGET_EXCEEDED",
  "CONNECTION",
  "INVALID_QUESTIONS",
  "INVALID_REQUEST",
  "INVALID_RESPONSE",
  "MODEL_MISMATCH",
  "OVERLOADED",
  "PERMISSION_DENIED",
  "RATE_LIMITED",
  "SERVER",
  "TIMEOUT",
  "UNKNOWN",
] as const;

export type JevErrorCode = (typeof JEV_ERROR_CODES)[number];

const RETRYABLE_CODES: ReadonlySet<JevErrorCode> = new Set([
  "CONNECTION",
  "OVERLOADED",
  "RATE_LIMITED",
  "SERVER",
  "TIMEOUT",
]);

export interface JevErrorDetails {
  readonly cause?: unknown;
  readonly status?: number | undefined;
  readonly requestId?: string | undefined;
}

/** Every failure from `JevClient.ask`, classified by a stable `code`. */
export class JevError extends Error {
  override readonly name = "JevError";
  readonly code: JevErrorCode;
  /** Whether retrying the same request later may succeed. */
  readonly retryable: boolean;
  /** HTTP status, when the failure came from an API response. */
  readonly status: number | undefined;
  /** TypeSafe request id, when the API returned one. Quote it in support requests. */
  readonly requestId: string | undefined;

  constructor(code: JevErrorCode, message: string, details: JevErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.code = code;
    this.retryable = RETRYABLE_CODES.has(code);
    this.status = details.status;
    this.requestId = details.requestId;
  }
}

/** Maps anything thrown while calling the TypeSafe SDK to a `JevError`. */
export function toJevError(error: unknown): JevError {
  if (error instanceof JevError) return error;
  if (error instanceof APIUserAbortError || isAbortError(error)) {
    return new JevError("ABORTED", "The request was aborted", { cause: error });
  }
  // APITimeoutError extends APIConnectionError, so it must be checked first.
  if (error instanceof APITimeoutError) {
    return new JevError("TIMEOUT", error.message, { cause: error });
  }
  if (error instanceof APIConnectionError) {
    return new JevError("CONNECTION", error.message, { cause: error });
  }
  if (error instanceof APIError) return fromApiError(error);
  const message = error instanceof Error ? error.message : String(error);
  return new JevError("UNKNOWN", message, { cause: error });
}

function fromApiError(error: APIError): JevError {
  const details = { cause: error, status: error.status, requestId: error.requestId };
  if (error instanceof RateLimitError) return new JevError("RATE_LIMITED", error.message, details);
  if (error instanceof AuthenticationError) {
    return new JevError("AUTHENTICATION", error.message, details);
  }
  if (error instanceof PermissionDeniedError) {
    return new JevError("PERMISSION_DENIED", error.message, details);
  }
  if (error instanceof BadRequestError || error instanceof UnprocessableEntityError) {
    return new JevError("INVALID_REQUEST", error.message, details);
  }
  if (error.status === 529) return new JevError("OVERLOADED", error.message, details);
  if (error instanceof InternalServerError) return new JevError("SERVER", error.message, details);
  return new JevError("UNKNOWN", error.message, details);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
