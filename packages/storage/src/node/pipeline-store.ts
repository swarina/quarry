import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  type AtsSource,
  type BoardId,
  type BoardStatus,
  boardId,
  htmlToText,
  isBoardGone,
  type NormalizedPosting,
  type PostingId,
} from "@quarry/domain";
import { migrate, openDatabase, transaction } from "./database.ts";
import { PIPELINE_MIGRATIONS } from "./migrations.ts";

export type RunTrigger = "schedule" | "manual" | "local";
export type CrawlOutcome = "listed" | "not-modified" | "failed" | "not-found" | "board-gone";

/** A board as the seed list or the removal list names it. */
export interface BoardRef {
  readonly source: AtsSource;
  readonly slug: string;
}

export interface SeedBoard extends BoardRef {
  readonly company: string;
  /** ISO 3166-1 alpha-2 code of the company's headquarters, when known. */
  readonly country: string | null;
}

export interface BoardRecord {
  readonly id: BoardId;
  readonly source: AtsSource;
  readonly slug: string;
  readonly company: string;
  readonly country: string | null;
  readonly origin: "seed" | "discovery";
  readonly status: BoardStatus;
  readonly etag: string | null;
  readonly etagNormalizerVersion: number | null;
  readonly lastSuccessAt: number | null;
  readonly lastListedCrawlId: number | null;
  readonly lastListedCount: number | null;
  readonly consecutiveFailures: number;
  readonly notFoundCount: number;
  readonly notFoundSince: number | null;
}

/** How one fetch of a board went, whatever its outcome. */
export interface CrawlAttempt {
  readonly runId: string;
  readonly startedAt: number;
  readonly finishedAt: number;
  /** HTTP requests made for this board, including retries. */
  readonly attempts: number;
  readonly bytes: number;
  readonly httpStatus: number | null;
}

/** A listed job, with ids and hashes computed before the write transaction starts. */
export type PreparedItem =
  | {
      readonly kind: "posting";
      readonly postingId: PostingId;
      readonly externalId: string;
      readonly posting: NormalizedPosting;
      readonly contentHash: string;
      readonly rawJson: string;
    }
  | { readonly kind: "invalid"; readonly postingId: PostingId; readonly externalId: string };

export interface ListingRecord {
  readonly items: readonly PreparedItem[];
  readonly etag: string | null;
  readonly normalizerVersion: number;
}

export interface CrawlFailure {
  readonly kind: "failed" | "not-found";
  readonly code: string;
  readonly message: string | null;
}

export interface RecordedCrawl {
  readonly crawlId: number;
  readonly outcome: CrawlOutcome;
  /** Postings recorded as present (not counting new jobs that failed validation). */
  readonly listed: number;
  readonly newPostings: number;
  readonly changedPostings: number;
  readonly invalid: number;
}

export interface BoardSyncResult {
  readonly added: number;
  readonly reactivated: number;
  readonly retired: number;
  readonly denied: number;
  readonly purgedPostings: number;
}

export interface RunSummary {
  readonly runId: string;
  readonly bySource: readonly {
    readonly source: AtsSource;
    readonly outcome: CrawlOutcome;
    readonly crawls: number;
    readonly newPostings: number;
    readonly changedPostings: number;
    readonly invalid: number;
    readonly bytes: number;
    readonly attempts: number;
  }[];
  readonly failures: readonly {
    readonly boardId: string;
    readonly outcome: CrawlOutcome;
    readonly httpStatus: number | null;
    readonly errorCode: string | null;
    readonly errorMessage: string | null;
  }[];
  readonly activeBoards: number;
  readonly listedPostings: number;
  readonly knownPostings: number;
}

/** A posting first seen on a board we had listed before, for measuring freshness. */
export interface FreshnessSample {
  /** The run whose crawl first saw the posting. */
  readonly runId: string;
  readonly source: AtsSource;
  /**
   * First sighting minus the publish time the ATS states, in milliseconds; null when it states
   * none. Negative when the ATS clock runs ahead of ours.
   */
  readonly latencyMs: number | null;
}

/** A posting its board's latest listing includes, as the search index takes it. */
export interface CurrentPosting {
  readonly id: PostingId;
  readonly company: string;
  /** The company's home country, from the seed list. */
  readonly companyCountry: string | null;
  readonly firstSeenAt: number;
  /** The posting as last read, without its description. */
  readonly posting: Omit<NormalizedPosting, "descriptionHtml">;
  /**
   * The answers held for this posting's current content, as the model gave them, keyed by
   * `<question id>@<version>`. Empty when nothing has answered it yet, and answers under a
   * wording that has since changed are still here under their own version, so the caller
   * decides which wordings it wants rather than being handed whichever exist.
   */
  readonly answers: Readonly<Record<string, string>>;
}

/** A posting whose current content has no answer to some question, with the text to ask about. */
export interface UnansweredPosting {
  readonly id: PostingId;
  readonly contentHash: string;
  readonly title: string;
  readonly company: string;
  readonly locations: readonly string[];
  /** The description as plain text, which is what the model is given. */
  readonly description: string;
}

/** One question's answer about one posting content, as the model gave it. */
export interface StoredAnswer {
  readonly contentHash: string;
  readonly questionId: string;
  readonly questionVersion: number;
  readonly model: string;
  readonly answeredAt: number;
  readonly answerJson: string;
}

export interface EnrichmentRun {
  readonly runId: string;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly asked: number;
  readonly failed: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costNanoUsd: number;
}

/**
 * Postings a listed board currently shows whose content lacks an answer to any of the wanted
 * questions. The wanted set is `id@version`, so a reworded question makes every posting
 * unanswered again; the parameters are bound rather than inlined, and only the count of
 * placeholders depends on the input.
 */
function unansweredWhere(wanted: readonly string[]): string {
  const missing = wanted
    .map(
      () => `NOT EXISTS (
           SELECT 1 FROM posting_answers a
           WHERE a.content_hash = p.content_hash AND a.question_id = ? AND a.question_version = ?
         )`,
    )
    .join("\n        OR ");
  return `FROM boards b
     JOIN posting_presence pp ON pp.last_crawl_id = b.last_listed_crawl_id
     JOIN postings p ON p.id = pp.posting_id AND p.board_id = b.id
     JOIN posting_contents c ON c.posting_id = p.id AND c.content_hash = p.content_hash
     WHERE b.status = 'active'
       AND (${missing})`;
}

function wantedParameters(wanted: readonly string[]): string[] {
  return wanted.flatMap((entry) => {
    const at = entry.lastIndexOf("@");
    return [entry.slice(0, at), entry.slice(at + 1)];
  });
}

function unansweredQuery(db: DatabaseSync, wanted: readonly string[]) {
  const statement = db.prepare(
    `SELECT p.id, p.content_hash, b.company, c.normalized_json AS posting
     ${unansweredWhere(wanted)}
     ORDER BY p.first_seen_at DESC, p.id
     LIMIT ?`,
  );
  return { all: (limit: number) => statement.all(...wantedParameters(wanted), limit) };
}

function unansweredCountQuery(db: DatabaseSync, wanted: readonly string[]) {
  const statement = db.prepare(`SELECT count(*) AS count ${unansweredWhere(wanted)}`);
  return { get: () => statement.get(...wantedParameters(wanted)) };
}

export interface PipelineStore {
  readonly db: DatabaseSync;
  close(): void;
  getMeta(key: string): string | undefined;
  setMeta(key: string, value: string): void;
  startRun(run: {
    readonly id: string;
    readonly trigger: RunTrigger;
    readonly codeVersion: string;
    readonly startedAt: number;
  }): void;
  finishRun(id: string, status: "succeeded" | "failed", finishedAt: number): void;
  /**
   * Makes the boards table match the seed list and the removal list: adds new seeds, retires
   * seeds that were removed, and marks removed boards as denied, deleting their postings.
   */
  syncBoards(
    seeds: readonly SeedBoard[],
    denied: readonly BoardRef[],
    now: number,
  ): BoardSyncResult;
  /** Active boards, least recently crawled first, so a run that runs out of time is fair. */
  activeBoards(): BoardRecord[];
  board(id: BoardId): BoardRecord | undefined;
  recordListing(board: BoardRecord, attempt: CrawlAttempt, listing: ListingRecord): RecordedCrawl;
  recordNotModified(board: BoardRecord, attempt: CrawlAttempt): RecordedCrawl;
  recordFailure(board: BoardRecord, attempt: CrawlAttempt, failure: CrawlFailure): RecordedCrawl;
  runSummary(runId: string): RunSummary;
  /**
   * Postings first seen at or after `since`, leaving out those on a board's first listing:
   * everything there is new to us however long it has been published.
   */
  freshnessSamples(since: number): FreshnessSample[];
  /**
   * The postings each active board's latest successful listing includes, read one at a time
   * (descriptions are left out, to keep memory small).
   */
  currentPostings(): Iterable<CurrentPosting>;
  /**
   * Postings a board currently lists whose content has no answer under every given question
   * version yet, newest first so a run cut short has answered the postings people are most
   * likely to be looking at. `wanted` is `id@version` for each question asked.
   */
  unanswered(wanted: readonly string[], limit: number): UnansweredPosting[];
  /** How many of the listed postings still lack an answer, for reporting before asking. */
  unansweredCount(wanted: readonly string[]): number;
  saveAnswers(answers: readonly StoredAnswer[]): void;
  recordEnrichment(run: EnrichmentRun): void;
}

type Row = Record<string, SQLInputValue>;

/** Opens (creating if needed) and migrates the pipeline store at `path`. */
export function openPipelineStore(path: string): PipelineStore {
  const db = openDatabase(path);
  migrate(db, PIPELINE_MIGRATIONS);
  return createPipelineStore(db);
}

export function createPipelineStore(db: DatabaseSync): PipelineStore {
  const statements = {
    getMeta: db.prepare("SELECT value FROM store_meta WHERE key = ?"),
    setMeta: db.prepare(
      "INSERT INTO store_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    ),
    startRun: db.prepare(
      `INSERT INTO runs (id, trigger, code_version, started_at, status)
       VALUES ($id, $trigger, $codeVersion, $startedAt, 'running')`,
    ),
    finishRun: db.prepare(
      "UPDATE runs SET status = $status, finished_at = $finishedAt WHERE id = $id",
    ),
    board: db.prepare("SELECT * FROM boards WHERE id = ?"),
    activeBoards: db.prepare(
      `SELECT * FROM boards WHERE status = 'active'
       ORDER BY last_success_at IS NOT NULL, last_success_at, id`,
    ),
    seedBoardIds: db.prepare("SELECT id FROM boards WHERE origin = 'seed' AND status = 'active'"),
    insertBoard: db.prepare(
      `INSERT INTO boards (id, source, slug, company, country, origin, status, created_at)
       VALUES ($id, $source, $slug, $company, $country, 'seed', $status, $createdAt)`,
    ),
    updateSeedBoard: db.prepare(
      `UPDATE boards SET slug = $slug, company = $company, country = $country, status = $status,
         origin = 'seed'
       WHERE id = $id`,
    ),
    retireBoard: db.prepare("UPDATE boards SET status = 'retired', etag = NULL WHERE id = ?"),
    // A denied board starts over if it is ever allowed again: its postings are gone.
    denyBoard: db.prepare(
      `UPDATE boards SET status = 'denied', etag = NULL, etag_normalizer_version = NULL,
         last_listed_crawl_id = NULL, last_listed_count = NULL
       WHERE id = ?`,
    ),
    deleteBoardPostings: db.prepare("DELETE FROM postings WHERE board_id = ?"),
    insertCrawl: db.prepare(
      `INSERT INTO board_crawls
         (board_id, run_id, started_at, finished_at, outcome, http_status, error_code,
          error_message, listed_count, attempts, bytes)
       VALUES ($boardId, $runId, $startedAt, $finishedAt, $outcome, $httpStatus, $errorCode,
          $errorMessage, $listedCount, $attempts, $bytes)
       RETURNING id`,
    ),
    finishListedCrawl: db.prepare(
      `UPDATE board_crawls SET listed_count = $listed, invalid_count = $invalid,
         new_count = $newPostings, changed_count = $changedPostings
       WHERE id = $crawlId`,
    ),
    postingState: db.prepare(
      `SELECT p.content_hash, c.normalizer_version
       FROM postings p
       LEFT JOIN posting_contents c ON c.posting_id = p.id AND c.content_hash = p.content_hash
       WHERE p.id = ?`,
    ),
    insertPosting: db.prepare(
      `INSERT INTO postings
         (id, board_id, external_id, content_hash, title, url, locations_json, published_at,
          first_seen_crawl_id, first_seen_at, last_seen_crawl_id, last_seen_at)
       VALUES ($id, $boardId, $externalId, $contentHash, $title, $url, $locations, $publishedAt,
          $crawlId, $at, $crawlId, $at)`,
    ),
    updatePosting: db.prepare(
      `UPDATE postings SET content_hash = $contentHash, title = $title, url = $url,
         locations_json = $locations, published_at = $publishedAt,
         last_seen_crawl_id = $crawlId, last_seen_at = $at
       WHERE id = $id`,
    ),
    touchPosting: db.prepare(
      "UPDATE postings SET last_seen_crawl_id = $crawlId, last_seen_at = $at WHERE id = $id",
    ),
    touchPresentPostings: db.prepare(
      `UPDATE postings SET last_seen_crawl_id = $crawlId, last_seen_at = $at
       WHERE id IN (SELECT posting_id FROM posting_presence WHERE last_crawl_id = $crawlId)`,
    ),
    // A content seen before (A to B and back to A) keeps its row, unless a newer normalizer
    // read it this time; then the row takes the newer reading.
    upsertContent: db.prepare(
      `INSERT INTO posting_contents
         (posting_id, content_hash, normalizer_version, normalized_json, raw_json)
       VALUES ($postingId, $contentHash, $normalizerVersion, $normalizedJson, $rawJson)
       ON CONFLICT (posting_id, content_hash) DO UPDATE SET
         normalizer_version = excluded.normalizer_version,
         normalized_json = excluded.normalized_json,
         raw_json = excluded.raw_json
       WHERE excluded.normalizer_version > posting_contents.normalizer_version`,
    ),
    insertChange: db.prepare(
      `INSERT INTO posting_changes (posting_id, crawl_id, content_hash)
       VALUES ($postingId, $crawlId, $contentHash)`,
    ),
    extendPresence: db.prepare(
      `UPDATE posting_presence SET last_crawl_id = $crawlId
       WHERE posting_id = $postingId AND last_crawl_id = $previous`,
    ),
    extendBoardPresence: db.prepare(
      "UPDATE posting_presence SET last_crawl_id = $crawlId WHERE last_crawl_id = $previous",
    ),
    insertPresence: db.prepare(
      `INSERT INTO posting_presence (posting_id, first_crawl_id, last_crawl_id)
       VALUES ($postingId, $crawlId, $crawlId)`,
    ),
    boardSucceeded: db.prepare(
      `UPDATE boards SET last_attempt_at = $attemptedAt, last_success_at = $succeededAt,
         last_listed_crawl_id = $crawlId, last_listed_count = $listed,
         etag = $etag, etag_normalizer_version = $etagVersion,
         consecutive_failures = 0, not_found_count = 0, not_found_since = NULL
       WHERE id = $id`,
    ),
    boardFailed: db.prepare(
      `UPDATE boards SET last_attempt_at = $attemptedAt,
         consecutive_failures = consecutive_failures + 1,
         not_found_count = $notFoundCount, not_found_since = $notFoundSince, status = $status
       WHERE id = $id`,
    ),
    summaryBySource: db.prepare(
      `SELECT b.source, c.outcome, count(*) AS crawls, sum(c.new_count) AS new_postings,
         sum(c.changed_count) AS changed_postings, sum(c.invalid_count) AS invalid,
         sum(c.bytes) AS bytes, sum(c.attempts) AS attempts
       FROM board_crawls c JOIN boards b ON b.id = c.board_id
       WHERE c.run_id = ?
       GROUP BY b.source, c.outcome
       ORDER BY b.source, c.outcome`,
    ),
    summaryFailures: db.prepare(
      `SELECT board_id, outcome, http_status, error_code, error_message FROM board_crawls
       WHERE run_id = ? AND outcome NOT IN ('listed', 'not-modified')
       ORDER BY board_id`,
    ),
    summaryTotals: db.prepare(
      `SELECT count(*) AS active, coalesce(sum(last_listed_count), 0) AS listed
       FROM boards WHERE status = 'active'`,
    ),
    postingCount: db.prepare("SELECT count(*) AS count FROM postings"),
    freshnessSamples: db.prepare(
      `SELECT first_crawl.run_id, b.source, p.first_seen_at - p.published_at AS latency_ms
       FROM postings p
       JOIN boards b ON b.id = p.board_id
       JOIN board_crawls first_crawl ON first_crawl.id = p.first_seen_crawl_id
       WHERE p.first_seen_at >= ?
         AND EXISTS (
           SELECT 1 FROM board_crawls earlier
           WHERE earlier.board_id = p.board_id AND earlier.outcome = 'listed'
             AND earlier.id < p.first_seen_crawl_id
         )
       ORDER BY p.first_seen_at, p.id`,
    ),
    saveAnswer: db.prepare(
      `INSERT INTO posting_answers
         (content_hash, question_id, question_version, model, answered_at, answer_json)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (content_hash, question_id, question_version) DO UPDATE SET
         model = excluded.model,
         answered_at = excluded.answered_at,
         answer_json = excluded.answer_json`,
    ),
    recordEnrichment: db.prepare(
      `INSERT INTO enrichment_runs
         (run_id, started_at, finished_at, asked, failed, input_tokens, output_tokens, cost_nano_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (run_id) DO UPDATE SET
         finished_at = excluded.finished_at,
         asked = enrichment_runs.asked + excluded.asked,
         failed = enrichment_runs.failed + excluded.failed,
         input_tokens = enrichment_runs.input_tokens + excluded.input_tokens,
         output_tokens = enrichment_runs.output_tokens + excluded.output_tokens,
         cost_nano_usd = enrichment_runs.cost_nano_usd + excluded.cost_nano_usd`,
    ),
    currentPostings: db.prepare(
      `SELECT p.id, p.first_seen_at, b.company, b.country,
         json_remove(c.normalized_json, '$.descriptionHtml') AS posting,
         -- Answers travel with the posting so the index is built in one pass. Keyed on the
         -- content hash, so an edited posting shows only the answers to the text it has now.
         (SELECT json_group_object(a.question_id || '@' || a.question_version, a.answer_json)
            FROM posting_answers a WHERE a.content_hash = p.content_hash) AS answers
       FROM boards b
       JOIN posting_presence pp ON pp.last_crawl_id = b.last_listed_crawl_id
       JOIN postings p ON p.id = pp.posting_id AND p.board_id = b.id
       JOIN posting_contents c ON c.posting_id = p.id AND c.content_hash = p.content_hash
       WHERE b.status = 'active'
       ORDER BY p.id`,
    ),
  };

  function insertCrawl(
    board: BoardRecord,
    attempt: CrawlAttempt,
    outcome: CrawlOutcome,
    listedCount: number | null,
    failure?: CrawlFailure,
  ): number {
    const row = statements.insertCrawl.get({
      boardId: board.id,
      runId: attempt.runId,
      startedAt: attempt.startedAt,
      finishedAt: attempt.finishedAt,
      outcome,
      httpStatus: attempt.httpStatus,
      errorCode: failure?.code ?? null,
      errorMessage: failure?.message ?? null,
      listedCount,
      attempts: attempt.attempts,
      bytes: attempt.bytes,
    }) as { id: number };
    return row.id;
  }

  /**
   * The board as stored now. Callers pass the record they read at the start of a run; the
   * writes below use the stored state, so an old record can never mislead them.
   */
  function currentBoard(board: BoardRecord): BoardRecord {
    const row = statements.board.get(board.id) as Row | undefined;
    if (row === undefined) throw new Error(`Unknown board ${board.id}`);
    return toBoardRecord(row);
  }

  function boardSucceeded(
    board: BoardRecord,
    attempt: CrawlAttempt,
    crawlId: number,
    listed: number,
    etag: string | null,
    etagVersion: number | null,
  ): void {
    statements.boardSucceeded.run({
      id: board.id,
      attemptedAt: attempt.startedAt,
      succeededAt: attempt.finishedAt,
      crawlId,
      listed,
      etag,
      etagVersion,
    });
  }

  return {
    db,

    close() {
      db.close();
    },

    getMeta(key) {
      const row = statements.getMeta.get(key) as { value: string } | undefined;
      return row?.value;
    },

    setMeta(key, value) {
      statements.setMeta.run(key, value);
    },

    startRun(run) {
      statements.startRun.run({ ...run });
    },

    finishRun(id, status, finishedAt) {
      statements.finishRun.run({ id, status, finishedAt });
    },

    syncBoards(seeds, denied, now) {
      return transaction(db, () => {
        const deniedIds = new Set<string>(denied.map((ref) => boardId(ref.source, ref.slug)));
        const seeded = new Set<string>();
        let added = 0;
        let reactivated = 0;
        for (const seed of seeds) {
          const id = boardId(seed.source, seed.slug);
          if (deniedIds.has(id)) continue;
          seeded.add(id);
          const existing = statements.board.get(id) as Row | undefined;
          if (existing === undefined) {
            statements.insertBoard.run({
              id,
              source: seed.source,
              slug: seed.slug,
              company: seed.company,
              country: seed.country,
              status: "active",
              createdAt: now,
            });
            added += 1;
            continue;
          }
          const revived = existing["status"] === "retired" || existing["status"] === "denied";
          if (revived) reactivated += 1;
          statements.updateSeedBoard.run({
            id,
            slug: seed.slug,
            company: seed.company,
            country: seed.country,
            status: revived ? "active" : (existing["status"] as string),
          });
        }

        let retired = 0;
        for (const row of statements.seedBoardIds.all() as { id: string }[]) {
          if (seeded.has(row.id) || deniedIds.has(row.id)) continue;
          statements.retireBoard.run(row.id);
          retired += 1;
        }

        let deniedCount = 0;
        let purgedPostings = 0;
        for (const ref of denied) {
          const id = boardId(ref.source, ref.slug);
          const existing = statements.board.get(id) as Row | undefined;
          if (existing === undefined) {
            statements.insertBoard.run({
              id,
              source: ref.source,
              slug: ref.slug,
              company: ref.slug,
              country: null,
              status: "denied",
              createdAt: now,
            });
          } else if (existing["status"] !== "denied") {
            statements.denyBoard.run(id);
          } else {
            continue;
          }
          purgedPostings += Number(statements.deleteBoardPostings.run(id).changes);
          deniedCount += 1;
        }
        return { added, reactivated, retired, denied: deniedCount, purgedPostings };
      });
    },

    activeBoards() {
      return (statements.activeBoards.all() as Row[]).map(toBoardRecord);
    },

    board(id) {
      const row = statements.board.get(id) as Row | undefined;
      return row === undefined ? undefined : toBoardRecord(row);
    },

    recordListing(given, attempt, listing) {
      return transaction(db, () => {
        const board = currentBoard(given);
        const crawlId = insertCrawl(board, attempt, "listed", null);
        const previous = board.lastListedCrawlId;
        const at = attempt.finishedAt;
        let listed = 0;
        let newPostings = 0;
        let changedPostings = 0;
        let invalid = 0;

        for (const item of listing.items) {
          const existing = statements.postingState.get(item.postingId) as
            | { content_hash: string; normalizer_version: number | null }
            | undefined;
          if (item.kind === "invalid") {
            invalid += 1;
            // A job we have never parsed has no record to mark present; it is counted and
            // reported, and picked up once it parses.
            if (existing === undefined) continue;
            statements.touchPosting.run({ id: item.postingId, crawlId, at });
          } else {
            const { posting } = item;
            const fields = {
              id: item.postingId,
              contentHash: item.contentHash,
              title: posting.title,
              url: posting.url,
              locations: JSON.stringify(posting.locations),
              publishedAt: posting.publishedAt,
              crawlId,
              at,
            };
            if (existing === undefined) {
              statements.insertPosting.run({
                ...fields,
                boardId: board.id,
                externalId: item.externalId,
              });
              newPostings += 1;
            } else {
              statements.updatePosting.run(fields);
              if (existing.content_hash !== item.contentHash) changedPostings += 1;
            }
            const changed = existing === undefined || existing.content_hash !== item.contentHash;
            // Unchanged content read by a newer normalizer (which may fill fields outside the
            // content, such as places) is stored again, without counting as an edit.
            const reread =
              existing !== undefined &&
              !changed &&
              (existing.normalizer_version ?? 0) < listing.normalizerVersion;
            if (changed || reread) {
              statements.upsertContent.run({
                postingId: item.postingId,
                contentHash: item.contentHash,
                normalizerVersion: listing.normalizerVersion,
                normalizedJson: JSON.stringify(posting),
                rawJson: item.rawJson,
              });
            }
            if (changed) {
              statements.insertChange.run({
                postingId: item.postingId,
                crawlId,
                contentHash: item.contentHash,
              });
            }
          }

          const extended = statements.extendPresence.run({
            postingId: item.postingId,
            previous,
            crawlId,
          }).changes;
          if (extended === 0) statements.insertPresence.run({ postingId: item.postingId, crawlId });
          listed += 1;
        }

        statements.finishListedCrawl.run({
          crawlId,
          listed,
          invalid,
          newPostings,
          changedPostings,
        });
        // With invalid jobs, skip the ETag, so the next run refetches the full listing and
        // picks those jobs up once a parser fix ships.
        const cacheable = invalid === 0 && listing.etag !== null;
        boardSucceeded(
          board,
          attempt,
          crawlId,
          listed,
          cacheable ? listing.etag : null,
          cacheable ? listing.normalizerVersion : null,
        );
        return { crawlId, outcome: "listed", listed, newPostings, changedPostings, invalid };
      });
    },

    recordNotModified(given, attempt) {
      return transaction(db, () => {
        const board = currentBoard(given);
        const previous = board.lastListedCrawlId;
        if (previous === null) {
          throw new Error(`Board ${board.id} has no earlier listing to be unchanged from`);
        }
        const crawlId = insertCrawl(board, attempt, "not-modified", board.lastListedCount);
        const listed = Number(statements.extendBoardPresence.run({ previous, crawlId }).changes);
        statements.touchPresentPostings.run({ crawlId, at: attempt.finishedAt });
        boardSucceeded(board, attempt, crawlId, listed, board.etag, board.etagNormalizerVersion);
        return {
          crawlId,
          outcome: "not-modified",
          listed,
          newPostings: 0,
          changedPostings: 0,
          invalid: 0,
        };
      });
    },

    recordFailure(given, attempt, failure) {
      return transaction(db, () => {
        const board = currentBoard(given);
        let outcome: CrawlOutcome = failure.kind;
        let notFoundCount = 0;
        let notFoundSince: number | null = null;
        let status: BoardStatus = board.status;
        if (failure.kind === "not-found") {
          notFoundCount = board.notFoundCount + 1;
          notFoundSince = board.notFoundSince ?? attempt.startedAt;
          if (isBoardGone(notFoundCount, notFoundSince, attempt.startedAt)) {
            outcome = "board-gone";
            status = "gone";
          }
        } else {
          notFoundCount = board.notFoundCount;
          notFoundSince = board.notFoundSince;
        }
        const crawlId = insertCrawl(board, attempt, outcome, null, failure);
        statements.boardFailed.run({
          id: board.id,
          attemptedAt: attempt.startedAt,
          notFoundCount,
          notFoundSince,
          status,
        });
        return { crawlId, outcome, listed: 0, newPostings: 0, changedPostings: 0, invalid: 0 };
      });
    },

    runSummary(runId) {
      const bySource = (statements.summaryBySource.all(runId) as Row[]).map((row) => ({
        source: row["source"] as AtsSource,
        outcome: row["outcome"] as CrawlOutcome,
        crawls: Number(row["crawls"]),
        newPostings: Number(row["new_postings"]),
        changedPostings: Number(row["changed_postings"]),
        invalid: Number(row["invalid"]),
        bytes: Number(row["bytes"]),
        attempts: Number(row["attempts"]),
      }));
      const failures = (statements.summaryFailures.all(runId) as Row[]).map((row) => ({
        boardId: row["board_id"] as string,
        outcome: row["outcome"] as CrawlOutcome,
        httpStatus: (row["http_status"] as number | null) ?? null,
        errorCode: (row["error_code"] as string | null) ?? null,
        errorMessage: (row["error_message"] as string | null) ?? null,
      }));
      const totals = statements.summaryTotals.get() as { active: number; listed: number };
      const known = statements.postingCount.get() as { count: number };
      return {
        runId,
        bySource,
        failures,
        activeBoards: totals.active,
        listedPostings: totals.listed,
        knownPostings: known.count,
      };
    },

    freshnessSamples(since) {
      return (statements.freshnessSamples.all(since) as Row[]).map((row) => ({
        runId: row["run_id"] as string,
        source: row["source"] as AtsSource,
        latencyMs: (row["latency_ms"] as number | null) ?? null,
      }));
    },

    *currentPostings() {
      for (const row of statements.currentPostings.iterate() as Iterable<Row>) {
        const posting = JSON.parse(row["posting"] as string) as Omit<
          NormalizedPosting,
          "descriptionHtml"
        >;
        yield {
          id: row["id"] as PostingId,
          company: row["company"] as string,
          companyCountry: row["country"] as string | null,
          firstSeenAt: row["first_seen_at"] as number,
          // Content stored before places existed has none.
          posting: { ...posting, places: posting.places ?? [] },
          answers: JSON.parse(row["answers"] as string) as Record<string, string>,
        };
      }
    },

    unanswered(wanted, limit) {
      if (wanted.length === 0) return [];
      return (unansweredQuery(db, wanted).all(limit) as Row[]).map((row) => {
        const posting = JSON.parse(row["posting"] as string) as NormalizedPosting;
        return {
          id: row["id"] as PostingId,
          contentHash: row["content_hash"] as string,
          title: posting.title,
          company: row["company"] as string,
          locations: posting.locations,
          description: htmlToText(posting.descriptionHtml ?? ""),
        };
      });
    },

    unansweredCount(wanted) {
      if (wanted.length === 0) return 0;
      const row = unansweredCountQuery(db, wanted).get() as Row | undefined;
      return Number(row?.["count"] ?? 0);
    },

    saveAnswers(answers) {
      transaction(db, () => {
        for (const answer of answers) {
          statements.saveAnswer.run(
            answer.contentHash,
            answer.questionId,
            answer.questionVersion,
            answer.model,
            answer.answeredAt,
            answer.answerJson,
          );
        }
      });
    },

    recordEnrichment(run) {
      statements.recordEnrichment.run(
        run.runId,
        run.startedAt,
        run.finishedAt,
        run.asked,
        run.failed,
        run.inputTokens,
        run.outputTokens,
        run.costNanoUsd,
      );
    },
  };
}

function toBoardRecord(row: Row): BoardRecord {
  return {
    id: row["id"] as BoardId,
    source: row["source"] as AtsSource,
    slug: row["slug"] as string,
    company: row["company"] as string,
    country: row["country"] as string | null,
    origin: row["origin"] as "seed" | "discovery",
    status: row["status"] as BoardStatus,
    etag: row["etag"] as string | null,
    etagNormalizerVersion: row["etag_normalizer_version"] as number | null,
    lastSuccessAt: row["last_success_at"] as number | null,
    lastListedCrawlId: row["last_listed_crawl_id"] as number | null,
    lastListedCount: row["last_listed_count"] as number | null,
    consecutiveFailures: row["consecutive_failures"] as number,
    notFoundCount: row["not_found_count"] as number,
    notFoundSince: row["not_found_since"] as number | null,
  };
}
