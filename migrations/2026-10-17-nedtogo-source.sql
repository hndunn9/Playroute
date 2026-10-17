-- Ned to Go (Nederland community calendar) as an automatic source.
-- Run after the PR adding SOURCE_RUNNERS.nedtogo is merged.
INSERT INTO scrape_sources (city, platform, base_url, adapter_type, mode, method, cadence, confidence, auto_publish, enabled, source_key, notes)
SELECT 'Nederland', 'Ned to Go (WordPress, WP Event Manager)', 'https://nedtogo.com/nederland-colorado-events', 'scraper', 'auto', 'json', 'weekly-a', 'review', 0, 1, 'nedtogo',
       'REST list + event pages for dates; kid/family listings only'
WHERE NOT EXISTS (SELECT 1 FROM scrape_sources WHERE source_key = 'nedtogo');
