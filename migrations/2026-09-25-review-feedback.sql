-- Review feedback loop (applied to production 2026-09-25).
ALTER TABLE pending_events ADD COLUMN reject_reason TEXT;
CREATE TABLE IF NOT EXISTS review_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER,
  title_key TEXT NOT NULL,
  title_example TEXT,
  action TEXT NOT NULL DEFAULT 'skip',
  reason TEXT,
  created_from_pending_id INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  hits INTEGER DEFAULT 0,
  last_hit_at TEXT,
  UNIQUE(source_id, title_key)
);
CREATE INDEX IF NOT EXISTS idx_pending_source_title ON pending_events(source_id, title);
