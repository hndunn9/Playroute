-- Indexes for the hottest read paths (2026-10-02). D1 bills/limits by rows
-- READ, and without these every time-window query scans the whole table:
-- /api/stats alone runs ~14 page_views range queries per call. With an index
-- on the timestamp, a "this week" query reads only this week's rows.
-- Safe to re-run (IF NOT EXISTS). Run once the daily read limit has reset
-- (building an index reads each table once).

CREATE INDEX IF NOT EXISTS idx_page_views_viewed_at ON page_views(viewed_at);
CREATE INDEX IF NOT EXISTS idx_link_clicks_clicked_at ON link_clicks(clicked_at);
CREATE INDEX IF NOT EXISTS idx_link_clicks_event_id ON link_clicks(event_id);
CREATE INDEX IF NOT EXISTS idx_search_queries_searched_at ON search_queries(searched_at);
CREATE INDEX IF NOT EXISTS idx_events_source_id ON events(source_id);
CREATE INDEX IF NOT EXISTS idx_events_city_date ON events(city, event_date);
CREATE INDEX IF NOT EXISTS idx_events_title_city ON events(title, city);
CREATE INDEX IF NOT EXISTS idx_pending_status ON pending_events(status);
CREATE INDEX IF NOT EXISTS idx_pending_existing_event ON pending_events(existing_event_id);
CREATE INDEX IF NOT EXISTS idx_engagement_week ON engagement_digests(week_start);
