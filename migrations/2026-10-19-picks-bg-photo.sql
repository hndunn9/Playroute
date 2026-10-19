-- Optional background photo for a Pick (R2 key under partner-photos/, served via /api/photos/).
-- Run BEFORE merging: the admin upload writes this column. Old code ignores it (SELECT *).
ALTER TABLE partner_previews ADD COLUMN bg_url TEXT;
