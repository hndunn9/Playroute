# Playroute Worker

One Cloudflare Worker that does two jobs:
1. **Scraper** — a scheduled (cron) job that pulls events from each library's LibCal API and upserts them into `playroute-db` (D1).
2. **API** — serves that data as JSON at `/api/events`, `/api/playgrounds`, `/api/hikes`, `/api/sources`, so the frontend can eventually fetch live data instead of using the hardcoded JS array.

## What's actually blocking this from running today

The scraper code is complete and correct against LibCal's documented API shape, but it **cannot authenticate without real API credentials** — and I can't get those for you. Each library issues its own `client_id` / `client_secret` for their LibCal instance, and there's no public/anonymous way to call the events API.

**To unblock this, email each library and ask for LibCal API (v1.1) access:**
- **Boulder Public Library District** — ask for API access to their LibCal calendar (calendar.boulderlibrary.org). Contact via their general library contact form.
- **High Plains Library District** (covers Erie Community Library) — same ask, for highplains.libcal.com.

Tell them you want **OAuth2 client-credentials API access to the Events API (v1.1)** for a personal/community project. This is a standard, supported Springshare feature — libraries grant it fairly routinely, but it's a real email + wait, not a self-serve signup.

Longmont, Lyons, and Broomfield aren't on LibCal, so this scraper doesn't cover them — see `scrape_sources` in the database for notes on what each of those needs instead (a custom scraper adapter for Longmont/Lyons, and likely a manual process for Broomfield since their site blocks automated access).

## Deploy steps

I can't run these myself — the sandbox this chat runs in doesn't have network access to Cloudflare's API. You'll need to run this from your own machine.

```bash
# 1. Install dependencies
cd playroute-worker
npm install

# 2. Log into your Cloudflare account
npx wrangler login

# 3. Once you have credentials from a library, set them as secrets
#    (repeat per library — key names must match LIBCAL_<KEY>_CLIENT_ID/SECRET
#    where <KEY> matches the `key` field in src/index.js, e.g. BOULDER, ERIE)
npx wrangler secret put LIBCAL_BOULDER_CLIENT_ID
npx wrangler secret put LIBCAL_BOULDER_CLIENT_SECRET
npx wrangler secret put LIBCAL_ERIE_CLIENT_ID
npx wrangler secret put LIBCAL_ERIE_CLIENT_SECRET

# 4. Deploy
npx wrangler deploy
```

After deploying, Wrangler prints your Worker's URL (something like `https://playroute-worker.<your-subdomain>.workers.dev`). Test it:

```bash
curl https://playroute-worker.<your-subdomain>.workers.dev/api/events
```

## Testing the scraper without waiting for the daily cron

Once secrets are set and deployed:

```bash
curl -X POST https://playroute-worker.<your-subdomain>.workers.dev/api/scrape-now
```

This runs the scrape immediately and returns a per-library status report — useful for confirming credentials actually work before waiting for the 9am UTC cron.

## What still needs building after this

- Scraper adapters for Longmont, Lyons, and (if possible) Broomfield — none of these are LibCal, so `src/libcal.js` doesn't apply to them.
- Rec center adapters (ActiveNet/PerfectMind/etc.) — bigger lift, separate research needed per platform.
- Swapping the static site's hardcoded JS array to fetch from this Worker's `/api/events` endpoint instead.
- A `libcal_event_id` uniqueness guarantee assumes LibCal event IDs are stable across days — worth spot-checking after your first real scrape run, since recurring event series sometimes get a new ID per occurrence rather than one stable ID for the series.
