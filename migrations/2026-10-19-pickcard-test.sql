-- Pick card format test (standard vs visual) + the visual card's extra fields.
-- Run BEFORE merging: admin saves write the new columns and /api/pick-event
-- upserts on (pick, day, arm). pick_stats was empty when recreated (Picks not live).
DROP TABLE IF EXISTS pick_stats;
CREATE TABLE pick_stats (
  pick TEXT NOT NULL,
  day TEXT NOT NULL,
  arm TEXT NOT NULL DEFAULT 'standard',
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (pick, day, arm)
);
ALTER TABLE partner_previews ADD COLUMN badge TEXT;
ALTER TABLE partner_previews ADD COLUMN chips TEXT;
ALTER TABLE partner_previews ADD COLUMN note TEXT;
