-- Switch on three automatic sources. Run AFTER deploying the Worker code in
-- this PR (museum_of_boulder and mountain_kids description fixes, new
-- bouldercounty_parks runner). Everything still lands in the review queue.
-- The 2026-10-01 migration set these up but rows 21 and 64 were never
-- flipped from manual.

UPDATE scrape_sources
SET mode = 'auto', method = 'tribe_rest', adapter_type = 'api', cadence = 'weekly-a',
    confidence = 'review', auto_publish = 0, source_key = 'museum_of_boulder',
    platform = 'Museum of Boulder (Events Calendar API)',
    notes = 'museumofboulder.org/wp-json/tribe/events/v1/events, 6 weeks ahead. For Kids and Families only; Member Exclusive dropped unless the text says drop-in / free with admission. Schedule lines and partner bios stripped from the note.'
WHERE id = 21;

UPDATE scrape_sources
SET mode = 'auto', method = 'jackrabbit_json', adapter_type = 'api', cadence = 'weekly-a',
    confidence = 'review', auto_publish = 0, source_key = 'mountain_kids',
    platform = 'Mountain Kids (Jackrabbit, Louisville + Erie)',
    notes = 'app.jackrabbitclass.com/jr3.0/Openings/OpeningsJson?OrgID=135459. Free or drop-in classes only (e.g. Twinkle Stars); paid if the class text names a fee. Camps and parties are not in this feed and still need adding by hand.'
WHERE id = 64;

-- Boulder County Parks & Open Space: replaces the JS-only Discover/Offero
-- calendar with the county site's Events Calendar API.
UPDATE scrape_sources
SET mode = 'auto', method = 'tribe_rest', adapter_type = 'api', cadence = 'weekly-a',
    confidence = 'review', auto_publish = 0, source_key = 'bouldercounty_parks',
    base_url = 'https://bouldercounty.gov/events/',
    platform = 'Boulder County Parks & Open Space (Events Calendar API)',
    notes = 'bouldercounty.gov/wp-json/tribe/events/v1/events?categories=parks-open-space, 60 days ahead. Hikes & Events, Ag Heritage Center, art and Assay Office programs; meetings, committees, seniors-only, work projects and hours-only listings dropped.'
WHERE id = 27;
