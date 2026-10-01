-- Switch Louisville Community Yoga (scrape_sources id 76) from manual to the
-- Browser Run scraper. Run AFTER deploying the Worker code that registers
-- SOURCE_RUNNERS.louisville_community_yoga, otherwise runs report
-- "no_runner_registered".
UPDATE scrape_sources
SET mode = 'auto', method = 'browser_run', adapter_type = 'scraper', cadence = 'weekly-c',
    confidence = 'review', auto_publish = 0, source_key = 'louisville_community_yoga',
    notes = 'WellnessLiving widget (signed API). Scraped via Cloudflare Browser Run /json on the workshops page; family-keyword filtered; all results go to pending review.'
WHERE id = 76;
