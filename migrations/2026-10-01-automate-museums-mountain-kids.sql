-- Switch three manual sources to automatic runners. Run AFTER deploying the
-- Worker code that registers SOURCE_RUNNERS.museum_of_boulder,
-- longmont_museum and mountain_kids, otherwise runs report
-- "no_runner_registered". All results still go to the review queue.

-- Museum of Boulder: The Events Calendar REST API, kids/family categories,
-- members-only events dropped.
UPDATE scrape_sources
SET mode = 'auto', method = 'tribe_rest', adapter_type = 'api', cadence = 'weekly-a',
    confidence = 'review', auto_publish = 0, source_key = 'museum_of_boulder',
    platform = 'Museum of Boulder (Events Calendar API)',
    notes = 'museumofboulder.org/wp-json/tribe/events/v1/events, 6 weeks ahead. Keeps For Kids and Families / Children''s Program; drops Member Exclusive and all-day.'
WHERE id = 21;

-- Longmont Museum: same city calendar layout as longmont_library, museum
-- category, kid/family listings only.
UPDATE scrape_sources
SET mode = 'auto', method = 'html', adapter_type = 'scraper', cadence = 'weekly-a',
    confidence = 'review', auto_publish = 0, source_key = 'longmont_museum',
    platform = 'Longmont Museum (City of Longmont calendar)',
    notes = 'longmontcolorado.gov/events/category/museum/ (up to 6 pages), parsed with the Longmont library parser; kid/family keyword gate.'
WHERE id = 52;

-- Mountain Kids (Louisville + Erie): Jackrabbit OpeningsJson, free/drop-in
-- classes only (enrolled programs skipped), weekly with season dates.
UPDATE scrape_sources
SET mode = 'auto', method = 'jackrabbit_json', adapter_type = 'api', cadence = 'weekly-a',
    confidence = 'review', auto_publish = 0, source_key = 'mountain_kids',
    platform = 'Mountain Kids (Jackrabbit, Louisville + Erie)',
    notes = 'app.jackrabbitclass.com/jr3.0/Openings/OpeningsJson?OrgID=135459. Free or drop-in classes only.'
WHERE id = 64;
