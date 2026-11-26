/**
 * The three criterion ports, backed by Cloudflare D1.
 *
 * This is the edge counterpart of `@quarry/criteria/node`'s store-backed ports. It talks to D1
 * through the small slice of its API used here, declared below rather than pulled from
 * `@cloudflare/workers-types`, so the package needs no extra types and the same declarations let
 * a Node test drive the adapter against `node:sqlite`.
 *
 * The shapes and limits are from ADR-0029 and its amendment: at most 100 bound parameters per
 * statement, so a lookup over many ids is chunked, and a `batch()` counts as one query against
 * the per-invocation limit, so the chunks go out together rather than one await at a time.
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

/** Bound parameters per statement (ADR-0029). */
const MAX_PARAMS = 100;

/** Prefixes per posting statement: each spends two parameters, on its lower and upper bound. */
const PREFIXES_PER_STATEMENT = Math.floor(MAX_PARAMS / 2);

/**
 * Appended to a prefix to make the exclusive upper bound of the ids it names.
 *
 * `id` is `TEXT`, so it compares under SQLite's default BINARY collation, which orders strings by
 * their UTF-8 bytes. U+10FFFF is the largest code point there is, so for any prefix `p`:
 * every id beginning with `p` sorts in `[p, p + U+10FFFF)`, and every id that does not begin with
 * `p` sorts outside it. Appending rather than incrementing the prefix's last character keeps that
 * true for every prefix a request can send, including one whose last character has no successor
 * that is a valid string on its own.
 */
const RANGE_END = "\u{10FFFF}";

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
 * Each prefix is matched as the range of ids it names, `id >= p AND id < p + U+10FFFF`, which the
 * primary key on `id` serves as an index seek. The ranges are OR'd together, chunked so no
 * statement exceeds the parameter limit, and sent as one `batch()`: a page of 500 is ten
 * statements, one query against the per-invocation limit, and one round trip.
 *
 * The obvious predicate, `substr(id, 1, n) IN (...)`, is what this used to be. It cannot use the
 * primary key, because an index on `id` says nothing about the order of `substr(id, 1, n)`, so
 * every statement read the whole table. Over the 37,314 rows exported today that was about
 * 224,000 row reads for one page; the ranges read one row per posting returned.
 */
export function createD1PostingSource(db: D1Database): PostingSource {
  return {
    async read(idPrefixes) {
      const prefixes = [...new Set(idPrefixes)].filter((prefix) => prefix !== "");
      if (prefixes.length === 0) return [];

      const statements = chunk(prefixes, PREFIXES_PER_STATEMENT).map((group) =>
        db
          .prepare(
            `SELECT id, content_hash, title, company, locations_json, description
               FROM criterion_postings
              WHERE ${group.map(() => "(id >= ? AND id < ?)").join(" OR ")}`,
          )
          .bind(...group.flatMap((prefix) => [prefix, `${prefix}${RANGE_END}`])),
      );
      const batched = await db.batch<PostingRow>(statements);

      // Deduplicated by id, because a request that mixes prefix lengths can name one posting
      // from two chunks. Prefixes of one length, which is what the index produces, cannot.
      const rows = new Map<string, PostingRow>();
      for (const { results } of batched) for (const row of results) rows.set(row.id, row);

      // Rows under the prefix each one would be named by, at every length the request used, so
      // deciding a prefix is a lookup rather than a pass over everything that came back.
      const byPrefix = new Map<string, PostingRow[]>();
      for (const length of new Set(prefixes.map((prefix) => prefix.length))) {
        for (const row of rows.values()) {
          const key = row.id.slice(0, length);
          const sharing = byPrefix.get(key) ?? [];
          sharing.push(row);
          byPrefix.set(key, sharing);
        }
      }

      const found: PostingText[] = [];
      for (const prefix of prefixes) {
        const sharing = byPrefix.get(prefix);
        // Exactly one, or none: an ambiguous prefix names no posting in particular.
        if (sharing === undefined || sharing.length !== 1) continue;
        const row = sharing[0] as PostingRow;
        found.push({
          id: row.id,
          contentHash: row.content_hash,
          title: row.title,
          company: row.company,
          locations: JSON.parse(row.locations_json) as readonly string[],
          description: row.description,
        });
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
