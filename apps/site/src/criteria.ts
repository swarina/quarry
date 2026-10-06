/**
 * Talking to the criterion path.
 *
 * The wire shapes are declared here rather than imported from `@quarry/criteria`, for the same
 * reason the shards carry their own questions instead of the browser importing the registry: the
 * package reaches `@quarry/jev` and through it the TypeSafe SDK, and the site pays for every byte
 * it ships. What crosses the wire is JSON, so the browser needs the shape and not the code.
 *
 * The cost of a second declaration is that it can drift from the one the server enforces.
 * `criteria.test.ts` closes that by driving these requests against a real handler, so a change on
 * either side that the other would reject fails a test rather than a person's first click.
 *
 * Every request goes to a path on this origin. The site's content security policy allows
 * `connect-src 'self'` and nothing else, so a cross-origin criterion path could not be reached
 * from here even if one were configured (ADR-0028).
 */
import { authorization } from "./credentials.ts";

/** Criteria per request, and postings per request, as the handler enforces them. */
export const MAX_CRITERIA = 5;
export const MAX_POSTINGS = 500;

/**
 * A criterion as the page holds it: what someone typed, in one shape for all three kinds.
 *
 * `choices` is the pick-one options for `choice`, the levels lowest first for `scale`, and
 * unused for `yes-no`. One field rather than three keeps it short in a URL, which is where a
 * search lives.
 */
export interface CriterionDraft {
  readonly kind: "yes-no" | "choice" | "scale";
  readonly question: string;
  readonly choices: readonly string[];
}

/** An option of a criterion: the id an answer is keyed by, and what to call it on screen. */
export interface DraftOption {
  readonly id: string;
  readonly label: string;
}

/**
 * The options a draft's answers will be distributed over, in the order the probabilities come
 * back in. This mirrors `readCriterion`, which is the authority; `criteria.test.ts` asserts the
 * two agree for all three kinds, because a mismatch here would label an answer with the wrong
 * option and look like a bad model rather than a bad join.
 */
export function draftOptions(draft: CriterionDraft): readonly DraftOption[] {
  if (draft.kind === "yes-no") {
    return [
      { id: "no", label: "No" },
      { id: "yes", label: "Yes" },
    ];
  }
  if (draft.kind === "choice") {
    return draft.choices.map((label) => ({ id: label, label }));
  }
  // Score answers are keyed by level index, lowest first.
  return draft.choices.map((label, at) => ({ id: String(at), label }));
}

/** What the page sends. The server reads this and nothing else off the criterion. */
function toWire(draft: CriterionDraft): Record<string, unknown> {
  if (draft.kind === "yes-no") return { kind: "yes-no", question: draft.question };
  if (draft.kind === "choice") {
    return {
      kind: "choice",
      question: draft.question,
      // An option may carry a `what` describing it, which Jev reads. The page does not offer one
      // yet: a second box per option is a lot of screen for a thing whose value is unmeasured.
      options: draft.choices.map((label) => ({ label })),
    };
  }
  return { kind: "scale", question: draft.question, levels: [...draft.choices] };
}

/** Whether a draft is complete enough to send, and what is missing when it is not. */
export function draftProblem(draft: CriterionDraft): string | undefined {
  if (draft.question.trim() === "") return "Write a question first.";
  if (draft.question.trim().length > 500) return "That question is longer than 500 characters.";
  if (draft.kind === "yes-no") return undefined;
  const filled = draft.choices.filter((choice) => choice.trim() !== "");
  const what = draft.kind === "choice" ? "options" : "levels";
  if (filled.length < 2) return `A ${draft.kind} question needs at least 2 ${what}.`;
  if (new Set(filled).size !== filled.length) return `Two ${what} have the same wording.`;
  if (draft.kind === "scale" && filled.length > 10) return "A scale allows at most 10 levels.";
  if (filled.some((choice) => choice.length > 120)) {
    return `Each of the ${what} is at most 120 characters.`;
  }
  return undefined;
}

/** How the server describes a criterion back, so an answer can be labelled. */
export interface CriterionDescription {
  readonly id: string;
  readonly kind: string;
  readonly options: readonly string[];
  readonly labels: readonly string[];
}

export interface CriterionEstimate {
  readonly postings: number;
  readonly texts: number;
  readonly wanted: number;
  readonly cached: number;
  readonly toAsk: number;
  readonly nanoUsd: number;
}

export interface EstimateReply {
  readonly criteria: readonly CriterionDescription[];
  readonly estimate: CriterionEstimate;
  readonly limits: {
    readonly perRequestNanoUsd: number;
    readonly perDayNanoUsd: number;
    readonly committedTodayNanoUsd: number;
  };
}

export interface AskReply {
  readonly criteria: readonly CriterionDescription[];
  readonly answers: readonly {
    readonly id: string;
    readonly answers: readonly {
      readonly criterionId: string;
      readonly distribution: readonly number[];
      readonly cached: boolean;
    }[];
  }[];
  readonly report: {
    readonly postings: number;
    readonly texts: number;
    readonly wanted: number;
    readonly cached: number;
    readonly asked: number;
    readonly failed: number;
    readonly costNanoUsd: number;
    readonly stoppedBy: "finished" | "budget" | "deadline" | "errors";
    readonly outstanding: number;
    readonly errors: readonly string[];
  };
}

/** A refusal from the criterion path, carrying the server's own words for what was wrong. */
export class CriteriaRequestError extends Error {
  override readonly name = "CriteriaRequestError";
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** What `fetch` has to look like, so a test can drive this without a network or a browser. */
export type Fetch = (path: string, init: RequestInit) => Promise<Response>;

async function post(route: string, body: unknown, send: Fetch): Promise<unknown> {
  let response: Response;
  try {
    response = await send(route, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: authorization() },
      body: JSON.stringify(body),
    });
  } catch (caught) {
    // A refused connection and a dropped network look the same here, and both mean the same
    // thing to a reader: the question was not asked, so nothing was spent.
    throw new CriteriaRequestError(
      caught instanceof Error ? caught.message : "the request could not be sent",
      "UNREACHABLE",
      0,
    );
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new CriteriaRequestError(
      `the server answered ${response.status}`,
      "MALFORMED",
      response.status,
    );
  }
  if (!response.ok) {
    const error = (parsed as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    const message = typeof error?.message === "string" ? error.message : `HTTP ${response.status}`;
    const code = typeof error?.code === "string" ? error.code : "ERROR";
    throw new CriteriaRequestError(message, code, response.status);
  }
  return parsed;
}

/** What asking would cost, and how much of it is already answered. Spends nothing. */
export async function estimate(
  draft: CriterionDraft,
  postings: readonly string[],
  send: Fetch,
): Promise<EstimateReply> {
  return (await post(
    "/criteria/estimate",
    { criteria: [toWire(draft)], postings: [...postings] },
    send,
  )) as EstimateReply;
}

/** Asks, within the request's allowance. */
export async function ask(
  draft: CriterionDraft,
  postings: readonly string[],
  send: Fetch,
): Promise<AskReply> {
  return (await post(
    "/criteria/ask",
    { criteria: [toWire(draft)], postings: [...postings] },
    send,
  )) as AskReply;
}

/** A cost in nano-dollars as money, to the cent it will actually appear as. */
export function usd(nanoUsd: number): string {
  const dollars = nanoUsd / 1e9;
  if (dollars === 0) return "nothing";
  if (dollars < 0.01) return "under $0.01";
  return `$${dollars.toFixed(2)}`;
}

/**
 * What to say about a run that did not finish. A partial answer read as a complete one is the
 * mistake the stop reason exists to prevent (ADR-0025), so each one names what to do next.
 */
export function stoppedBecause(reply: AskReply): string | undefined {
  const { report } = reply;
  if (report.stoppedBy === "finished" && report.failed === 0) return undefined;
  const left = `${report.outstanding} of ${report.wanted} left unanswered`;
  if (report.stoppedBy === "budget") {
    return `Stopped on the spending limit, ${left}. Narrow the search and ask again.`;
  }
  if (report.stoppedBy === "deadline") {
    return `Ran out of time, ${left}. Narrow the search and ask again; what was answered is kept.`;
  }
  if (report.stoppedBy === "errors") {
    return `Stopped after repeated failures, ${left}. ${report.errors[0] ?? ""}`.trim();
  }
  return `${report.failed} postings could not be answered, ${left}.`;
}
