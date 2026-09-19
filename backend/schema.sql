-- Minimal by design. Every table here exists because something in the request
-- path reads it; nothing is speculative.

-- Who may spend the owner's API credit. A run costs real money, so this is an
-- allowlist, not a registry of everyone who ever messaged the channel.
CREATE TABLE IF NOT EXISTS users (
  kakao_id   TEXT PRIMARY KEY,
  label      TEXT,
  plan       TEXT NOT NULL DEFAULT 'owner',  -- owner | cloud | business
  runs_month INTEGER NOT NULL DEFAULT 0,
  runs_limit INTEGER NOT NULL DEFAULT 50,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per dispatched run. Lets a later message answer "is it done yet"
-- without calling the GitHub API, and is the basis for usage metering.
CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kakao_id    TEXT NOT NULL,
  task        TEXT NOT NULL,
  issue       INTEGER,
  status      TEXT NOT NULL DEFAULT 'dispatched', -- dispatched | done | failed
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS runs_by_user ON runs (kakao_id, created_at DESC);
