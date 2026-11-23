-- Downtown Longmont (LDDA) calendar: automatic weekly run into the review
-- queue, family events only (runner: downtown_longmont, src/downtown-longmont.js).
UPDATE scrape_sources
SET mode = 'auto', method = 'html', cadence = 'weekly-a', confidence = 'review', auto_publish = 0,
    adapter_type = 'scraper', source_key = 'downtown_longmont',
    base_url = 'https://www.downtownlongmont.com/events/calendar'
WHERE id = 28;
