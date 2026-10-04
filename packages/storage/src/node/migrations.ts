import type { Migration } from "./database.ts";

/**
 * Pipeline store schema, applied in order and tracked with `PRAGMA user_version`. Migrations
 * are forward-only: never edit one that has shipped; add a new one.
 *
 * Crawls are recorded as observations (ADR-0016): `board_crawls` says what each fetch of a
 * board returned, and `posting_presence` stores, per posting, runs of consecutive successful
 * crawls in which it was listed. Lifecycle state is derived from those facts, never stored as
 * the only record.
 *
 * `WITHOUT ROWID` is used only for tables with small rows, as SQLite recommends; tables with
 * large rows (postings, their contents) are ordinary rowid tables.
 */
export const PIPELINE_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "crawl observations",
    sql: `
      CREATE TABLE store_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT, WITHOUT ROWID;

      CREATE TABLE runs (
        id           TEXT PRIMARY KEY,
        trigger      TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual', 'local')),
        code_version TEXT NOT NULL,
        started_at   INTEGER NOT NULL,
        finished_at  INTEGER,
        status       TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed'))
      ) STRICT, WITHOUT ROWID;

      CREATE TABLE boards (
        id                      TEXT PRIMARY KEY,
        source                  TEXT NOT NULL
                                CHECK (source IN ('greenhouse', 'lever', 'lever-eu', 'ashby')),
        slug                    TEXT NOT NULL,
        company                 TEXT NOT NULL,
        country                 TEXT CHECK (country IS NULL OR country GLOB '[A-Z][A-Z]'),
        origin                  TEXT NOT NULL CHECK (origin IN ('seed', 'discovery')),
        status                  TEXT NOT NULL CHECK (status IN ('active', 'retired', 'gone', 'denied')),
        created_at              INTEGER NOT NULL,
        etag                    TEXT,
        etag_normalizer_version INTEGER,
        last_attempt_at         INTEGER,
        last_success_at         INTEGER,
        last_listed_crawl_id    INTEGER,
        last_listed_count       INTEGER,
        consecutive_failures    INTEGER NOT NULL DEFAULT 0,
        not_found_count         INTEGER NOT NULL DEFAULT 0,
        not_found_since         INTEGER
      ) STRICT, WITHOUT ROWID;

      -- AUTOINCREMENT: crawl ids must never be reused, because the lifecycle orders by them.
      CREATE TABLE board_crawls (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        board_id      TEXT NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
        run_id        TEXT NOT NULL REFERENCES runs (id),
        started_at    INTEGER NOT NULL,
        finished_at   INTEGER NOT NULL,
        outcome       TEXT NOT NULL CHECK (
                        outcome IN ('listed', 'not-modified', 'failed', 'not-found', 'board-gone')
                      ),
        http_status   INTEGER,
        error_code    TEXT,
        error_message TEXT,
        listed_count  INTEGER,
        invalid_count INTEGER NOT NULL DEFAULT 0,
        new_count     INTEGER NOT NULL DEFAULT 0,
        changed_count INTEGER NOT NULL DEFAULT 0,
        attempts      INTEGER NOT NULL DEFAULT 0,
        bytes         INTEGER NOT NULL DEFAULT 0,
        UNIQUE (board_id, run_id)
      ) STRICT;
      CREATE INDEX board_crawls_by_run ON board_crawls (run_id);

      CREATE TABLE postings (
        id                  TEXT PRIMARY KEY,
        board_id            TEXT NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
        external_id         TEXT NOT NULL,
        content_hash        TEXT NOT NULL,
        title               TEXT NOT NULL,
        url                 TEXT NOT NULL,
        locations_json      TEXT NOT NULL,
        published_at        INTEGER,
        first_seen_crawl_id INTEGER NOT NULL,
        first_seen_at       INTEGER NOT NULL,
        last_seen_crawl_id  INTEGER NOT NULL,
        last_seen_at        INTEGER NOT NULL,
        UNIQUE (board_id, external_id)
      ) STRICT;

      -- Each distinct content a posting has had, with the raw item it was parsed from.
      CREATE TABLE posting_contents (
        posting_id         TEXT NOT NULL REFERENCES postings (id) ON DELETE CASCADE,
        content_hash       TEXT NOT NULL,
        normalizer_version INTEGER NOT NULL,
        normalized_json    TEXT NOT NULL,
        raw_json           TEXT,
        PRIMARY KEY (posting_id, content_hash)
      ) STRICT;

      -- Every crawl at which a posting's content differed from what we had (including the
      -- first sighting), so A -> B -> A edits are all visible.
      CREATE TABLE posting_changes (
        posting_id   TEXT NOT NULL REFERENCES postings (id) ON DELETE CASCADE,
        crawl_id     INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        PRIMARY KEY (posting_id, crawl_id)
      ) STRICT, WITHOUT ROWID;

      -- Runs of consecutive successful crawls of the posting's board that listed the posting.
      CREATE TABLE posting_presence (
        posting_id     TEXT NOT NULL REFERENCES postings (id) ON DELETE CASCADE,
        first_crawl_id INTEGER NOT NULL,
        last_crawl_id  INTEGER NOT NULL,
        PRIMARY KEY (posting_id, first_crawl_id)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX posting_presence_by_last_crawl ON posting_presence (last_crawl_id);
    `,
  },
  {
    version: 2,
    name: "answers to the standard questions",
    sql: `
      -- One row per posting content and question wording. Keyed on the content hash, not the
      -- posting, so an edited posting is asked again while an unchanged one is never paid for
      -- twice; keyed on the question version because a reworded question is a new question.
      CREATE TABLE posting_answers (
        content_hash     TEXT NOT NULL,
        question_id      TEXT NOT NULL,
        question_version INTEGER NOT NULL,
        model            TEXT NOT NULL,
        answered_at      INTEGER NOT NULL,
        -- The answer as the model gave it: its type, its choice or number, and its
        -- probabilities. Read through the facets layer, never trusted as a bare value.
        answer_json      TEXT NOT NULL,
        PRIMARY KEY (content_hash, question_id, question_version)
      ) STRICT, WITHOUT ROWID;

      -- What each request cost, so spend is auditable against the ledger and the budget.
      CREATE TABLE enrichment_runs (
        run_id        TEXT NOT NULL REFERENCES runs (id),
        started_at    INTEGER NOT NULL,
        finished_at   INTEGER NOT NULL,
        asked         INTEGER NOT NULL,
        failed        INTEGER NOT NULL,
        input_tokens  INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cost_nano_usd INTEGER NOT NULL,
        PRIMARY KEY (run_id)
      ) STRICT, WITHOUT ROWID;
    `,
  },
];
