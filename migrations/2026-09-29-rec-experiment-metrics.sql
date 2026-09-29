-- Already applied to production D1 on 2026-09-29. Per-session counters for
-- the "Recommended for you" 50/50 experiment (see handleRecommendedExperiment).
ALTER TABLE experiment_sessions ADD COLUMN exposed INTEGER DEFAULT 0;
ALTER TABLE experiment_sessions ADD COLUMN detail_views INTEGER DEFAULT 0;
ALTER TABLE experiment_sessions ADD COLUMN source_clicks INTEGER DEFAULT 0;
ALTER TABLE experiment_sessions ADD COLUMN rec_clicks INTEGER DEFAULT 0;
