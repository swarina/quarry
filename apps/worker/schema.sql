-- The three tables the criterion path needs in D1 (ADR-0029). Posting text is loaded from the
-- pipeline store; the answer cache and the daily budget are written at runtime.
--
-- Apply with:  npx wrangler d1 execute quarry-criteria --remote --file=schema.sql
-- (the export command prepends this, so loading the dump creates the tables too.)

CREATE TABLE IF NOT EXISTS criterion_postings (
  id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  title TEXT NOT NULL,
  company TEXT NOT NULL,
  locations_json TEXT NOT NULL,
  description TEXT NOT NULL
);

-- Answers already paid for, keyed by criterion wording, model, and posting content (ADR-0024).
CREATE TABLE IF NOT EXISTS criterion_answers (
  criterion_id TEXT NOT NULL,
  model TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  answered_at INTEGER NOT NULL,
  answer_json TEXT NOT NULL,
  PRIMARY KEY (criterion_id, model, content_hash)
);

-- The daily spend backstop (ADR-0005), one row per UTC day.
CREATE TABLE IF NOT EXISTS criterion_spend (
  day TEXT PRIMARY KEY,
  committed_nano_usd INTEGER NOT NULL
);
