# Playroute

A family activity discovery app for Boulder County, Colorado and nearby towns — storytimes, playgrounds, hikes, farmers markets, and one-off events, all in one mobile-first feed. Built because finding "what's there to do with the kids this week" across a dozen different library calendars, town rec sites, and Facebook pages is a genuinely annoying problem.

**Live at:** [playroute.co](https://playroute.co)

## What it covers

Boulder, Erie, Longmont, Lafayette, Lyons, Broomfield, Louisville, Superior, Mead, and Nederland. The city filter is dynamic — it's built from whatever cities actually show up in the data, so adding a new town doesn't require a code change.

## Stack

- **Cloudflare Workers** (`src/index.js`) — API, scrapers, scheduled jobs, and serves the static frontend
- **D1** (`playroute-db`) — SQLite-based database
- **R2** (`playroute-photos`) — bucket for playground/park photos (manual upload only — nothing in this repo writes to it programmatically)
- **Resend** — weekly digest emails and admin notifications
- **Static assets** — served directly by the Worker from `public/`, no separate Pages deployment

No build step, no framework, no CLI required. Deployed by editing files directly (via github.dev or the GitHub web UI) and uploading through the Cloudflare dashboard.

## Project structure

```
public/
  index.html       — the app itself (single file: HTML + CSS + JS)
  admin.html       — private, unlisted admin panel (not linked from the app)
  robots.txt
  sitemap.xml
  hero-flatirons.jpg — hero banner photo
src/
  index.js         — the Worker: API routes, scrapers, cron jobs, email
wrangler.jsonc     — Worker config (D1/R2 bindings, cron triggers)
```

## Database (D1)

| Table | What it holds |
|---|---|
| `events` | The main event feed — recurring and one-off, with day/time/recurrence rules, age range, cost, category |
| `playgrounds` | Parks, farms, indoor play spaces — anywhere a family might go, not just literal playgrounds |
| `hikes` | Trails |
| `scrape_sources` | Tracks every source Playroute pulls from, and whether it's auto-scraped or needs manual checking |
| `page_views` | Anonymized visit tracking (hashed visitor ID, rotates weekly — no cookies, no persistent identity) |
| `link_clicks` | Tracks source-link clicks, calendar-adds, card expansions, shares, and support/feedback clicks |
| `subscribers` | Weekly digest email list |
| `pending_events` | Candidates found by the automated weekly scan, awaiting approval before going live |

`events`, `playgrounds`, and `pending_events` all have unique-index safeguards against accidental duplicate inserts.

## How events get in

Three tiers, roughly in order of trust:

1. **Fully automated, direct insert** — library iCal feeds (Boulder, Erie) and Mead's town JSON calendar. These upsert on every scheduled run using a stable per-source ID, so re-running never creates duplicates.
2. **Weekly automated *review* queue** — items from tracked sources that *couldn't* be confidently auto-parsed (ambiguous dates, multi-session listings) get surfaced for a human instead of guessed at or silently dropped. Every Sunday at 12pm Mountain Time, an email goes out with tap-to-approve/reject links for anything new.
3. **Manual entry** — most of the current data. Sources that are JavaScript-rendered (no static HTML to scrape), login-walled, or just need a human's judgment call get added by hand.

## Recurrence handling

Events support one-off dates, weekly recurrence, and monthly patterns (`monthly-last-sunday`, `monthly-first-wednesday`, `monthly-third-tuesday`, etc. — any ordinal + weekday combination). `season_start`/`season_end` (in `MM-DD` format) bound a recurring event to part of the year — including wraparound ranges (e.g. `12-01` to `10-31` to exclude just one month, every year, permanently).

Occurrence calculation is duration-aware: an event that's currently in progress stays visible until it actually ends, rather than disappearing the moment its start time passes.

## Weekly digest & admin tools

- Subscribers get a Sunday email with the coming week's events (`runWeeklyDigest`)
- `public/admin.html` — an unlisted, unauthenticated control panel (bookmark the URL, don't share it) for triggering a test digest, running the pending-events scan on demand, running all scrapers manually, and checking live stats
- `/api/stats` — full internal analytics (DAU/WAU, click breakdowns, geo). Unauthenticated — fine for a solo pilot, not something to expose.
- `/api/public-stats` — a single number only (`events_discovered_all_time`), safe to expose to the app's own users

## Analytics, privacy-mindedly

No cookies, no persistent visitor ID. Each pageview is hashed from IP + User-Agent + a salt that rotates every Monday — the same visitor gets a consistent hash *within* a week (so weekly-active-user counts work), but that hash can't be linked across different weeks. Geo data (country, US state, city) comes from Cloudflare's edge, not a third-party service.

`link_clicks` tracks: source-link clicks, "Open in Maps" clicks, calendar-adds, card expansions, shares, and support/feedback link clicks — each tagged by category so they can be sliced independently.

## Environment variables / secrets

Set these in the Cloudflare dashboard (Workers & Pages → your worker → Settings → Variables and Secrets):

| Secret | Used for |
|---|---|
| `RESEND_API_KEY` | Sending the weekly digest and admin emails |
| `DIGEST_FROM` | The "from" address for those emails — must match a domain verified in Resend, format `Name <email@domain.com>` |
| `ADMIN_EMAIL` | Where the Sunday pending-events review email goes |

D1 (`DB`) and R2 (`PHOTOS`) bindings are already configured in `wrangler.jsonc`.

## Cron schedule

Configured in `wrangler.jsonc`:
- `0 9 * * *` — daily at 9am UTC: runs all scrapers (library feeds, Mead, etc.)
- `0 18 * * 7` / `0 19 * * 7` — Sunday, both UTC times to cover both sides of Daylight Saving; whichever one actually lands at noon Mountain Time runs the weekly digest **and** the pending-events scan

## Known limitations

- No admin authentication on `admin.html` or `/api/stats` — acceptable for a low-stakes solo pilot, would need a real auth layer before wider use
- Several data sources are JS-rendered or login-walled and can't be automated at all — they're manually re-checked periodically instead
- "Events discovered all-time" counts actions (card expands + source clicks + calendar-adds + shares), not deduplicated unique events — someone who does all four for the same event counts four times
- Analytics only cover the period since tracking was added, not the app's entire history
