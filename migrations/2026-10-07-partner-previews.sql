-- Run AFTER the PR merges. Unlisted brand-preview + approval pages for partners
-- (playroute.co/partners/preview/<token>). Separate from `partners` and never
-- touches events/pending_events. First row: Warrior Playground.
CREATE TABLE IF NOT EXISTS partner_previews (
  token TEXT PRIMARY KEY,
  business_name TEXT NOT NULL,
  tagline TEXT,
  description TEXT,
  location TEXT,
  ages TEXT,
  cta_label TEXT,
  link_url TEXT,
  brand_color TEXT,
  logo_url TEXT,
  price_label TEXT DEFAULT '$75/month',
  go_live_date TEXT,
  status TEXT DEFAULT 'draft',
  approved_at TEXT,
  approved_by TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Update tagline/description/color/logo/link/go_live_date as Warrior Playground sends them.
INSERT INTO partner_previews (token, business_name, tagline, description, ages, brand_color, price_label)
VALUES ('804dcac3696dc9d9dd80d9a912b4fc1f', 'Warrior Playground', 'Early childhood movement program',
        'Membership details to come from partner.', 'Early childhood', '#46707E', '$75/month');
