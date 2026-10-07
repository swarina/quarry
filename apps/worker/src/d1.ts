/**
 * The three criterion ports, backed by Cloudflare D1.
 *
 * This is the edge counterpart of `@quarry/criteria/node`'s store-backed ports. It talks to D1
 * through the small slice of its API used here, declared below rather than pulled from
 * `@cloudflare/workers-types`, so the package needs no extra types and the same declarations let
 * a Node test drive the adapter against `node:sqlite`.
 *
 * The shapes and limits are from ADR-0029: at most 100 bound parameters per query, and each
 * statement in a `batch()` counts against the Worker's subrequest limit, so the posting lookup
 * resolves prefixes in chunked `IN` queries rather than one query per prefix.
 */
import type {
  AnswerCache,
  BudgetStore,
  CachedAnswer,
  PostingSource,
  PostingText,
} from "@quarry/criteria";

/** The slice of the D1 API this adapter uses. Both real D1 and the test shim satisfy it. */
export interface D1Result<T> {
  readonly results: readonly T[];
}
export interface D1PreparedStatement {
  bind(...values: readonly unknown[]): D1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}
export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(
    statements: readonly D1PreparedStatement[],
  ): Promise<readonly D1Result<T>[]>;
}

/** Bound parameters per query (ADR-0029). One is spent on the prefix length, the rest on values. */
const MAX_PARAMS = 100;

function chunk<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < values.length; at += size) out.push(values.slice(at, at + size));
  return out;
}

interface PostingRow {
  readonly id: string;
  readonly content_hash: string;
  readonly title: string;
  readonly company: string;
  readonly locations_json: string;
  readonly description: string;
}

/**
 * Posting text from D1, resolving id prefixes the way the store does: a prefix that matches
 * nothing, or more than one posting, is left out rather than guessed at.
 *
 * Prefixes are grouped by length (a request's prefixes all share the index's length, but grouping
 * keeps it correct if they ever differ) and matched with `substr(id, 1, n) IN (...)`, chunked so
 * no query exceeds the parameter limit. That is a handful of statements for a page of 500, rather
 * than one range scan per prefix, which would exceed the free plan's subrequest limit.
 */
export function createD1PostingSource(db: D1Database): PostingSource {
  return {
    async read(idPrefixes) {
      const byLength = new Map<number, Set<string>>();
      for (const prefix of idPrefixes) {
        if (prefix === "") continue;
        const set = byLength.get(prefix.length) ?? new Set<string>();
        set.add(prefix);
        byLength.set(prefix.length, set);
      }

      const found: PostingText[] = [];
      for (const [length, set] of byLength) {
        for (const group of chunk([...set], MAX_PARAMS - 1)) {
          const placeholders = group.map(() => "?").join(", ");
          const { results } = await db
            .prepare(
              `SELECT id, content_hash, title, company, locations_json, description
                 FROM criterion_postings
                WHERE substr(id, 1, ?) IN (${placeholders})`,
            )
            .bind(length, ...group)
            .all<PostingRow>();

          const byPrefix = new Map<string, PostingRow[]>();
          for (const row of results) {
            const key = row.id.slice(0, length);
            const rows = byPrefix.get(key) ?? [];
            rows.push(row);
            byPrefix.set(key, rows);
          }
          for (const prefix of group) {
            const rows = byPrefix.get(prefix);
            // Exactly one, or none: an ambiguous prefix names no posting in particular.
            if (rows === undefined || rows.length !== 1) continue;
            const row = rows[0] as PostingRow;
            found.push({
              id: row.id,
              contentHash: row.content_hash,
              title: row.title,
              company: row.company,
              locations: JSON.parse(row.locations_json) as readonly string[],
              description: row.description,
            });
          }
        }
      }
      return found;
    },
  };
}

/** The answer cache, backed by D1, so an answer is paid for once for everybody (ADR-0024). */
export function createD1AnswerCache(db: D1Database, now: () => number = Date.now): AnswerCache {
  return {
    async read(criterionId, model, contentHashes) {
      const hashes = [...new Set(contentHashes)];
      if (hashes.length === 0) return [];
      const found: CachedAnswer[] = [];
      // Two parameters are the criterion id and model, leaving room for the content hashes.
      for (const group of chunk(hashes, MAX_PARAMS - 2)) {
        const placeholders = group.map(() => "?").join(", ");
        const { results } = await db
          .prepare(
            `SELECT content_hash, answer_json FROM criterion_answers
              WHERE criterion_id = ? AND model = ? AND content_hash IN (${placeholders})`,
          )
          .bind(criterionId, model, ...group)
          .all<{ content_hash: string; answer_json: string }>();
        for (const row of results) {
          found.push({ contentHash: row.content_hash, answerJson: row.answer_json });
        }
      }
      return found;
    },
    async write(criterionId, model, answers) {
      if (answers.length === 0) return;
      const answeredAt = now();
      const statements = answers.map((answer) =>
        db
          .prepare(
            `INSERT INTO criterion_answers (criterion_id, model, content_hash, answered_at, answer_json)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (criterion_id, model, content_hash) DO UPDATE SET
               answered_at = excluded.answered_at,
               answer_json = excluded.answer_json`,
          )
          .bind(criterionId, model, answer.contentHash, answeredAt, answer.answerJson),
      );
      await db.batch(statements);
    },
  };
}

/**
 * The daily budget, backed by D1.
 *
 * A reservation has to be decided against a total no other request can be changing between the
 * read and the write. `node:sqlite` does this with `BEGIN IMMEDIATE`; here the read, the capped
 * increment, and the read-back run as one `batch()`, which D1 executes as a single serialized
 * transaction, so the grant is the difference between the committed total before and after.
 */
export function createD1BudgetStore(db: D1Database): BudgetStore {
  const committedOn = async (day: string): Promise<number> => {
    const { results } = await db
      .prepare("SELECT committed_nano_usd AS committed FROM criterion_spend WHERE day = ?")
      .bind(day)
      .all<{ committed: number }>();
    return results[0]?.committed ?? 0;
  };

  return {
    async reserve(day, wanted, perDayNanoUsd) {
      const before = db
        .prepare("SELECT committed_nano_usd AS committed FROM criterion_spend WHERE day = ?")
        .bind(day);
      const grant = db
        .prepare(
          `INSERT INTO criterion_spend (day, committed_nano_usd) VALUES (?, MIN(?, ?))
           ON CONFLICT (day) DO UPDATE SET
             committed_nano_usd = MIN(?, committed_nano_usd + ?)`,
        )
        .bind(day, wanted, perDayNanoUsd, perDayNanoUsd, wanted);
      const after = db
        .prepare("SELECT committed_nano_usd AS committed FROM criterion_spend WHERE day = ?")
        .bind(day);
      const [pre, , post] = await db.batch<{ committed: number }>([before, grant, after]);
      const already = pre?.results[0]?.committed ?? 0;
      const committed = post?.results[0]?.committed ?? already;
      return Math.max(0, committed - already);
    },
    async release(day, unspent) {
      if (unspent <= 0) return;
      await db
        .prepare(
          "UPDATE criterion_spend SET committed_nano_usd = MAX(0, committed_nano_usd - ?) WHERE day = ?",
        )
        .bind(unspent, day)
        .all();
    },
    committed(day) {
      return committedOn(day);
    },
  };
}
