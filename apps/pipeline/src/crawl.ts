import {
  AtsSchemaError,
  atsHost,
  type ListedItem,
  listingRequest,
  NORMALIZER_VERSION,
  parseListing,
} from "@quarry/ats";
import type { FetchOutcome, PoliteFetcher } from "@quarry/crawl";
import { postingContentHash, postingId } from "@quarry/domain";
import type {
  BoardRecord,
  CrawlAttempt,
  CrawlOutcome,
  PipelineStore,
  PreparedItem,
  RecordedCrawl,
} from "@quarry/storage/node";
import type { Logger } from "./log.ts";

export interface CrawlDependencies {
  readonly store: PipelineStore;
  readonly fetcher: PoliteFetcher;
  readonly log: Logger;
  readonly now: () => number;
}

export interface CrawlOptions {
  readonly runId: string;
  /** No board is started at or after this time; boards not reached stay due for the next run. */
  readonly deadline: number;
  readonly maxBoards?: number;
  readonly signal?: AbortSignal;
}

export interface CrawlReport {
  readonly due: number;
  readonly attempted: number;
  /** Boards not reached before the deadline. */
  readonly deferred: number;
  readonly outcomes: Readonly<Record<CrawlOutcome, number>>;
}

/** How many schema problems to log per board; the rest are only counted. */
const LOGGED_PROBLEMS_PER_BOARD = 3;

/**
 * Crawls every active board once, least recently crawled first. Each API host gets its own
 * queue, so hosts run in parallel while the polite fetcher paces requests within a host. Every
 * board's result is committed as soon as it is known, so an interrupted run keeps its progress.
 */
export async function crawlBoards(
  deps: CrawlDependencies,
  options: CrawlOptions,
): Promise<CrawlReport> {
  const boards = deps.store.activeBoards().slice(0, options.maxBoards);
  const queues = new Map<string, BoardRecord[]>();
  for (const board of boards) {
    const host = atsHost(board.source);
    queues.set(host, [...(queues.get(host) ?? []), board]);
  }

  const outcomes: Record<CrawlOutcome, number> = {
    listed: 0,
    "not-modified": 0,
    failed: 0,
    "not-found": 0,
    "board-gone": 0,
  };
  let attempted = 0;
  const results = await Promise.allSettled(
    [...queues.values()].map(async (queue) => {
      for (const board of queue) {
        if (deps.now() >= options.deadline) return;
        options.signal?.throwIfAborted();
        const recorded = await crawlBoard(deps, board, options);
        attempted += 1;
        outcomes[recorded.outcome] += 1;
      }
    }),
  );
  const failure = results.find((result) => result.status === "rejected");
  if (failure !== undefined) throw failure.reason;
  return { due: boards.length, attempted, deferred: boards.length - attempted, outcomes };
}

async function crawlBoard(
  deps: CrawlDependencies,
  board: BoardRecord,
  options: CrawlOptions,
): Promise<RecordedCrawl> {
  const startedAt = deps.now();
  const { url } = listingRequest(board.source, board.slug);
  // An ETag is only trusted for a listing parsed by the current normalizer; after a parser
  // change every board is refetched in full once.
  const revalidate =
    board.etag !== null &&
    board.etagNormalizerVersion === NORMALIZER_VERSION &&
    board.lastListedCrawlId !== null;
  const outcome = await deps.fetcher.get(url, {
    etag: revalidate ? board.etag : null,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const attempt: CrawlAttempt = {
    runId: options.runId,
    startedAt,
    finishedAt: deps.now(),
    attempts: outcome.kind === "skipped" ? 0 : outcome.attempts,
    bytes: outcome.kind === "ok" ? outcome.bytes : 0,
    httpStatus: httpStatus(outcome),
  };
  const recorded = await record(deps, board, attempt, outcome);
  deps.log.info("board crawled", {
    run_id: options.runId,
    board_id: board.id,
    outcome: recorded.outcome,
    http_status: attempt.httpStatus,
    ...(outcome.kind === "failed" ? { error_code: outcome.failure } : {}),
    ...(outcome.kind === "skipped" ? { error_code: outcome.reason } : {}),
    duration_ms: attempt.finishedAt - attempt.startedAt,
    listed: recorded.listed,
    new_postings: recorded.newPostings,
    changed_postings: recorded.changedPostings,
    invalid: recorded.invalid,
    bytes: attempt.bytes,
  });
  return recorded;
}

async function record(
  deps: CrawlDependencies,
  board: BoardRecord,
  attempt: CrawlAttempt,
  outcome: FetchOutcome,
): Promise<RecordedCrawl> {
  const { store } = deps;
  switch (outcome.kind) {
    case "ok": {
      let items: readonly ListedItem[];
      try {
        items = parseListing(board.source, JSON.parse(outcome.body)).items;
      } catch (error) {
        if (!(error instanceof SyntaxError || error instanceof AtsSchemaError)) throw error;
        return store.recordFailure(board, attempt, {
          kind: "failed",
          code: error instanceof SyntaxError ? "invalid-json" : "schema-drift",
          message: error.message,
        });
      }
      logProblems(deps.log, attempt.runId, board, items);
      return store.recordListing(board, attempt, {
        items: await prepareItems(board, items),
        etag: outcome.etag,
        normalizerVersion: NORMALIZER_VERSION,
      });
    }
    case "not-modified":
      return store.recordNotModified(board, attempt);
    case "not-found":
      return store.recordFailure(board, attempt, {
        kind: "not-found",
        code: "not-found",
        message: `HTTP ${outcome.status}`,
      });
    case "failed":
      return store.recordFailure(board, attempt, {
        kind: "failed",
        code: outcome.failure,
        message: outcome.message,
      });
    case "skipped":
      return store.recordFailure(board, attempt, {
        kind: "failed",
        code: outcome.reason,
        message: null,
      });
  }
}

/** Posting ids and content hashes use WebCrypto, which is async, so they are computed first. */
function prepareItems(board: BoardRecord, items: readonly ListedItem[]): Promise<PreparedItem[]> {
  return Promise.all(
    items.map(async (item): Promise<PreparedItem> => {
      const id = await postingId(board.id, item.externalId);
      if (item.kind === "invalid") {
        return { kind: "invalid", postingId: id, externalId: item.externalId };
      }
      return {
        kind: "posting",
        postingId: id,
        externalId: item.externalId,
        posting: item.posting,
        contentHash: await postingContentHash(item.posting),
        rawJson: JSON.stringify(item.raw),
      };
    }),
  );
}

function logProblems(log: Logger, runId: string, board: BoardRecord, items: readonly ListedItem[]) {
  const problems = items.filter((item) => item.kind === "invalid");
  for (const item of problems.slice(0, LOGGED_PROBLEMS_PER_BOARD)) {
    log.warn("job failed validation", {
      run_id: runId,
      board_id: board.id,
      error_code: "schema-drift",
      error_message: `${item.externalId}: ${item.problem}`,
    });
  }
}

function httpStatus(outcome: FetchOutcome): number | null {
  switch (outcome.kind) {
    case "ok":
    case "not-found":
      return outcome.status;
    case "not-modified":
      return 304;
    case "failed":
      return outcome.status;
    case "skipped":
      return null;
  }
}
