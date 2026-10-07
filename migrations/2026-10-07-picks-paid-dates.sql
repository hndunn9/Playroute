-- Run AFTER the Picks admin PR merges (safe to run before, too: old code ignores these).
ALTER TABLE partner_previews ADD COLUMN paid_at TEXT;
ALTER TABLE partner_previews ADD COLUMN ends_on TEXT;
