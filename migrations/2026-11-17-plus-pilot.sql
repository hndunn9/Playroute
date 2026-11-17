-- Playroute+ paid pilot ($20/year, unlocks events more than 7 days out).
-- RUN BEFORE MERGING: the new code reads and writes these tables.
-- Also needs visitor_first_seen (2026-11-17-visitor-first-seen.sql) for the
-- return-visit guardrail in admin.

-- One row per paying (or formerly paying) member, kept in sync by the
-- Stripe webhook. status is Stripe's subscription status, or 'refunded'.
CREATE TABLE IF NOT EXISTS plus_subscribers (
  email TEXT PRIMARY KEY,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  status TEXT NOT NULL,
  current_period_end TEXT,            -- ISO UTC
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  fs_id TEXT,                         -- browser that bought (pr_fs id), for test attribution
  arm TEXT,                           -- 'plus' | 'control' | NULL (preview / unknown)
  livemode INTEGER NOT NULL DEFAULT 0, -- 0 = Stripe test mode
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_plus_subscribers_sub ON plus_subscribers(stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_plus_subscribers_customer ON plus_subscribers(stripe_customer_id);

-- Emailed one-time sign-in links (only the SHA-256 of the token is stored).
CREATE TABLE IF NOT EXISTS plus_login_tokens (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_plus_login_tokens_email ON plus_login_tokens(email, created_at);

-- Funnel: first time each browser reaches each step. Previews are never logged.
-- steps: assigned, exposed, unlock_tap, checkout_start, purchased,
--        signin_request, not_now (detail = reason), why_subscribe (detail = answer)
CREATE TABLE IF NOT EXISTS plus_funnel (
  fs_id TEXT NOT NULL,
  arm TEXT NOT NULL,
  step TEXT NOT NULL,
  detail TEXT,
  first_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (fs_id, step)
);
CREATE INDEX IF NOT EXISTS idx_plus_funnel_step ON plus_funnel(step, arm);
