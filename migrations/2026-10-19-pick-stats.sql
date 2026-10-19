-- Per-partner daily counts for Playroute's Picks (app impressions + clicks).
-- One row per pick slug per Mountain-time day; upserted by /api/pick-event.
-- Keyed (pick, day) so the admin report's WHERE pick = ? AND day BETWEEN …
-- is an index range, not a scan.
CREATE TABLE IF NOT EXISTS pick_stats (
  pick TEXT NOT NULL,
  day TEXT NOT NULL,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (pick, day)
);
