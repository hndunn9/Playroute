-- Optional newsletter-only text for a Playroute's Pick (partners often send a longer,
-- differently worded blurb for the email than for the app card). Blank = the email
-- reuses `description`.
--
-- Additive column that the new code reads and writes, so it was applied to D1 on
-- 2026-10-20 BEFORE this PR merged (otherwise Pick saves fail until it runs).
ALTER TABLE partner_previews ADD COLUMN email_description TEXT;

-- Warrior Playground's newsletter text, as sent by the partner on 2026-10-20.
UPDATE partner_previews SET email_description = 'Looking for a fun way to help your little one build confidence?

At Warrior Playground, our Early Childhood Movement lessons turn play into purposeful learning! Through climbing, balancing, and obstacle courses, children ages 2–5 build confidence, coordination, and independence in small, coach-led groups designed to meet them where they are developmentally.

Come see the difference—your first lesson is FREE!'
WHERE token = '804dcac3696dc9d9dd80d9a912b4fc1f';
