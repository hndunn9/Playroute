-- Run AFTER the little-grove-sawyer PR is merged (the runner must exist first).
-- Registers Little Grove (Erie) open play from its Sawyer drop-in calendar.
INSERT INTO scrape_sources (city, platform, base_url, adapter_type, notes, mode, method, cadence, confidence, auto_publish, enabled, source_key)
VALUES ('Erie', 'Little Grove', 'https://www.hisawyer.com/little-grove-1/schedules/widget_calendar?schedule_id=drop-ins', 'scraper',
 'Sawyer widget (JS-rendered, no public API). Browser Run /markdown + Claude extraction; same-day slots merged into one listing; all results go to review.',
 'auto', 'browser_run', 'weekly-b', 'review', 0, 1, 'little_grove');
UPDATE events SET source_id = (SELECT id FROM scrape_sources WHERE source_key = 'little_grove') WHERE source = 'Little Grove';
