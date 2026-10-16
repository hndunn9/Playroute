-- Time-led event card A/B test (2026-10). One row per visit (per-tab session id
-- from the app), arm = 'control' | 'timeled'. See handleCardExperiment.
CREATE TABLE IF NOT EXISTS card_experiment_sessions (
  session_id TEXT PRIMARY KEY,
  arm TEXT NOT NULL,
  detail_views INTEGER DEFAULT 0,
  source_clicks INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
