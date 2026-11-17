-- First-seen cookie (pr_fs) — one row per browser.
-- RUN BEFORE MERGING: the new pageview code writes this table (writes are
-- wrapped, so a missing table only skips logging, but run it first anyway).
CREATE TABLE IF NOT EXISTS visitor_first_seen (
  fs_id TEXT PRIMARY KEY,          -- random id from the cookie, no personal data
  first_seen TEXT NOT NULL,        -- MT date (YYYY-MM-DD) the cookie was set
  prior_local INTEGER NOT NULL DEFAULT 0, -- 1 = browser already had Playroute data then (returning)
  last_seen TEXT NOT NULL,         -- MT date of the latest visit
  visit_days INTEGER NOT NULL DEFAULT 1   -- distinct days visited
);
CREATE INDEX IF NOT EXISTS idx_visitor_first_seen_first ON visitor_first_seen(first_seen);
CREATE INDEX IF NOT EXISTS idx_visitor_first_seen_last ON visitor_first_seen(last_seen);
