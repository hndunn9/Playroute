-- Optional newsletter-only button text for a Pick. NULL = use cta_label.
-- Run BEFORE merging the PR that adds it to PICK_CONTENT_FIELDS: admin saves
-- write this column, so it must exist first. Old code ignores it (SELECT *).
ALTER TABLE partner_previews ADD COLUMN email_cta_label TEXT;
