-- Weekly newsletter: agent drafts, owner approval, A/B variants, Resend events.
-- Run after the newsletter-approval PR merges:
--   wrangler d1 execute playroute-db --remote --file migrations/2026-10-13-newsletter-drafts.sql

CREATE TABLE IF NOT EXISTS newsletter_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  send_date TEXT NOT NULL UNIQUE,       -- YYYY-MM-DD (Sunday, Mountain Time)
  status TEXT NOT NULL DEFAULT 'draft', -- draft | approved | sending | sent | skipped
  subject_a TEXT NOT NULL,
  subject_b TEXT,                       -- only when this week's test is the subject line
  intro TEXT,
  intro_b TEXT,                         -- only when this week's test is the intro line
  spotlight_ids TEXT,                   -- JSON array of event ids for "Don't miss these"
  test_plan TEXT,                       -- JSON {variable, hypothesis, metric}, NULL = no test
  rationale TEXT,                       -- the agent's reasoning, shown in admin
  last_issue_readout TEXT,              -- the agent's read of the previous issue's results
  generated_by TEXT,                    -- model id, 'rules' (agent unavailable) or 'none'
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  approved_at TEXT,
  sent_at TEXT,
  send_summary TEXT                     -- JSON {A, B, errors, subscribers}
);

-- One row per email sent, so webhook events map back to issue + variant.
-- No email addresses stored here.
CREATE TABLE IF NOT EXISTS newsletter_sends (
  resend_id TEXT PRIMARY KEY,
  draft_id INTEGER NOT NULL,
  variant TEXT NOT NULL,                -- 'A' or 'B'
  sent_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_newsletter_sends_draft ON newsletter_sends(draft_id, variant);

CREATE TABLE IF NOT EXISTS newsletter_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  svix_id TEXT UNIQUE,                  -- Resend's delivery id; dedupes webhook retries
  resend_id TEXT NOT NULL,
  type TEXT NOT NULL,                   -- delivered | opened | clicked | bounced | complained
  link TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_newsletter_events_resend ON newsletter_events(resend_id, type);
