# Boulder Library Scraper

Scrapes Boulder Public Library's public calendar (they declined API access) and pushes normalized events straight into `playroute-db` via the Worker's `/api/ingest` endpoint.

## What's now grounded vs. still a first-run risk

**Grounded in real data** (confirmed against an actual PDF export of the filtered calendar, Jul 1–7 2026):
- The `Date:/Time:/Location:/Audience:/Categories:` label format on event pages
- That specific ages ("ages 3-5", "birth-15 months") live in the free-text description, **not** the Audience field (which is always just the broad "Birth to age 5" category — this was a real bug in the first draft, fixed after testing)
- Age-inference regex tested against 6 real examples from the PDF, all matched exactly

**Still unverified:**
- The Playwright discovery step (rendering the list view to find event URLs) — written to be resilient (matches any `/event/<id>` link rather than specific CSS classes) but never actually run, since this sandbox can't reach calendar.boulderlibrary.org
- Whether individual detail pages use `<h1>` for the title — reasonable assumption, not confirmed

## Setup

```bash
npm install
npx playwright install chromium   # downloads the browser Playwright needs
```

## Running it

```bash
# One-off run, prints JSON instead of posting anywhere:
node scrape.js

# Real run, posts straight into playroute-db:
export PLAYROUTE_WORKER_URL="https://playroute-worker.<your-subdomain>.workers.dev"
export PLAYROUTE_INGEST_SECRET="<same value you set with wrangler secret put INGEST_SECRET>"
node scrape.js
```

First run recommendation: run without the env vars set, so it just prints JSON — check that `raw_day`, `raw_start`, `age_min`/`age_max` look right for a handful of events before pointing it at the real database.

## Scheduling

This needs a real browser (Playwright), which Cloudflare Workers can't run — so unlike the LibCal-API-based scraper, this can't live inside the Worker's cron trigger. Options for running it on a schedule:
- A GitHub Action on a cron schedule (free tier covers this easily for a once-daily run)
- A small always-on machine/Raspberry Pi with a cron job
- Manually, whenever you remember — same as the PDF export approach, just automated
