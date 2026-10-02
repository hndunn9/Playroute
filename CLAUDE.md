# CLAUDE.md — working on Playroute

Context for AI assistants (and future-me) working in this repo. Keep it current:
when a rule here turns out wrong, fix it in the same PR.

## How changes ship
- **Merging to `main` deploys.** The Worker (`test`) is connected to this repo
  and redeploys ~30s after a merge. Never ask for manual paste/upload deploys.
- **Every code change goes out as a PR** for the owner to merge. Don't hand over
  files or Quick Edit instructions.
- **Database changes are not in PRs.** Data edits run directly against D1
  (`playroute-db`, id `f5da3542-a8fa-449a-9827-37d1104dd940`). Put schema or
  `scrape_sources` changes that depend on new code in `migrations/` and run them
  after the PR is merged.
- `wrangler.jsonc` is the source of truth for bindings. `keep_vars: true` keeps
  dashboard variables across deploys; prefer bindings over dashboard vars.
- Cron triggers are capped at **5** on this account (see `wrangler.jsonc`).

## D1 read budget
Workers Paid since 2026-10-02 (25B rows read/month included, then billed per million). On
the free tier the 5M/day cap took the whole site down; now overruns cost money instead, so
keep reads proportional to traffic:
- **No polling.** No `setInterval`/auto-refresh in the admin or the public site. Load data
  when a view opens; refresh on a button.
- **Cache read-heavy GETs.** New aggregate/report endpoints go in `EDGE_CACHE_TTLS`
  (`src/index.js`). `?fresh=1` bypasses. Don't cache endpoints that must reflect a write
  immediately (`/api/pending-events`).
- **Index what you filter on.** Any new `WHERE`/`JOIN` on a growing table (page_views,
  link_clicks, events, pending_events, search_queries) needs an index; add it to a migration.
  Existing ones: `migrations/2026-10-02-read-indexes.sql`.
- **No per-row queries in loops.** Batch-load once (see `preloadIngestIndex`) instead of a
  query per candidate or per pending item.
- **Ad-hoc analysis counts too.** Check `rows_read` in the D1 response meta. Avoid
  `LIKE '%…%'` joins across big tables (one such query read ~930k rows); filter by
  `source_id`/date first, `LIMIT` exploratory queries.
- If a change could plausibly add >100k reads/day, say so in the PR description.

## Before delivering code
- `node --check src/index.js` (and the other `src/*.js` you touched).
- For `public/*.html`: run a real HTML tag-matching parser (htmlparser2), a real
  CSS parser, and a syntax check on the inline `<script>`. Brace-counting isn't enough.
- **Never overwrite the GA4 snippet** (`G-V212HC6MVZ`) in `public/index.html`.

## Event data rules (D1 `events`)
- **Check for duplicates first**, every time: same title (loosely) + city +
  date/day + start time. A duplicate only counts at the *same location* —
  the same program at two branches or rooms is two events.
- `category` must be one of `library, rec, museum, outdoor, community,
  farmers_market` (CHECK constraint). `cost` is `free` or `paid`.
- `recurrence`: `dated` (with `event_date` YYYY-MM-DD), `weekly`, or
  `monthly-<ordinal>-<weekday>` (e.g. `monthly-first-friday`). `irregular`
  never displays.
- `season_start` / `season_end` are **MM-DD only**, never YYYY-MM-DD.
  Wraparound ranges work.
- Skip dates within a recurring series with `excluded_ranges`
  (JSON `[["YYYY-MM-DD","YYYY-MM-DD"], ...]`), **not** a note in the description.
- **Never type `\u` escapes in SQL strings.** D1 stores them literally. Use real
  UTF-8 characters (–, —, ’).
- Keep descriptions short (aim under ~250 chars). No holiday-break notes, no
  history, no guesses. Use only confirmed details from the source.
- Don't assume recurring vs one-time from a single posting. Confirm it.
- Cancelled or removed events are **deleted**, not marked.
- Set `source_id` to the matching `scrape_sources` row when one exists.
- Gyms and businesses: list drop-in events only, not membership programming.
- Athletic Adventures has a Frederick address but is always listed as **Erie**.

## Sources (`scrape_sources`)
- `mode='auto'` sources need a runner in `SOURCE_RUNNERS[source_key]`.
  `mode='manual'` sources are hand-entered and tracked for freshness via
  `MANUAL_SOURCE_KEYWORDS` (id → keyword matched against `events.source`).
  Register a manual source when a venue recurs.
- Weekly scrapers are split across `weekly-a/b/c` cadences (Sunday 18:00, 20:00,
  22:00 UTC) so each gets a fresh subrequest budget.
  Manual run: `POST /api/run-sources?source=<key>` or `?cadence=weekly-b`.
- Everything scraped goes to `pending_events` for review (`auto_publish=0`),
  except the trusted iCal/JSON feeds.
- **Boulder Public Library is on Communico** (since ~2026-09-28; the LibCal iCal feed and
  `/event/<id>` links are dead). `boulder_ical` runs `fetchBoulderCommunico` on the
  `api.communico.co/v2/boulderlibrary/events/export.xml?start=YYYY-MM-DD` export, capped at a
  35-day horizon (`BOULDER_HORIZON_DAYS`; the export can return months ahead, which once queued
  ~530 far-future items). Later windows are skipped once the horizon is covered. No per-event links exist, so `source_url` is the branch listing
  `calendar.boulderlibrary.org/events/?l=<Branch>`.
- Boulder library dedup keys include the room/source string. If the library
  renames a room, old and new rows can duplicate. Clean up by keeping the newer spelling.
- **Structured feeds worth checking first** when automating a manual source:
  WordPress The Events Calendar (`/wp-json/tribe/events/v1/events`, e.g. `museum_of_boulder`),
  Longmont city categories (reuse `fetchAndScanLongmontLibrary({ listUrl, category, kidOnly })`),
  Jackrabbit studios (`/jr3.0/Openings/OpeningsJson?OrgID=`, add to `JACKRABBIT_STUDIOS`; keep
  free/drop-in classes only), Communico libraries (`api.communico.co/v2/<org>/events/export.xml`).
  Queued items carry `season_start`/`season_end`, and approval copies them to `events`.
- **JS-rendered platforms** (WellnessLiving, Arketa, iClassPro) can't be read with
  `fetch()`. WellnessLiving's API needs a per-request signature, so use the
  Browser Run binding (`env.BROWSER`) via `browserRun()` and read the
  widget iframe (`runWellnessLivingStudio`).
  Workers Free allows **1 Browser Run request per 10 s** (429 otherwise).
  `browserRun()` spaces calls 11 s apart and retries a 429 once. Results are cached
  for 10 min so verification doesn't re-scrape.
  Each studio in `WELLNESSLIVING_STUDIOS` sets `familyOnly` (keyword filter on/off).
  A run that drops every event throws with the drop reasons, so it never reports "ok, 0 found".
  Flow: `/scrape` finds the widget iframe, `/markdown` renders it (networkidle0 + 5 s wait;
  studios with `pageWeeks` instead inject `wlWeekPagerScript` to click through that many weeks
  in the same call and capture each, reporting problems on a `PAGER:` line),
  then Claude (`WL_EXTRACT_MODEL`, needs `ANTHROPIC_API_KEY`) extracts sessions with today's
  date, because the widget's week headings omit the year. If the key is missing or the Claude
  call fails (e.g. low credit balance), it falls back to Cloudflare's model
  (`wlExtractWithCloudflareAI`, `env.AI` binding, else Browser Run `/json`), one week section per
  call; one call over all weeks returned a single session with no time. The reason is logged
  and included in any error. If no clock times render, the error quotes what the browser saw.
- **Subrequest budget:** `runSources` preloads seen dedup keys and a live-events index once per
  run (`preloadIngestIndex`) and checks duplicates in memory, so a run costs ~1 D1 call per NEW
  item instead of ~5 per candidate. Verification only judges live events up to the feed's
  furthest date and skips flagging (reports an error) if >30% (and >10) would be flagged at once.
- **Review learning** (`pipeline.js`): before queuing, `contentFilter` drops placeholder titles
  (DRAFT/TBD), "…Buddies – Register" series, ages 9+ or teen/tween titles (unless the title says
  family/all ages), and adult topics without a kid signal. Titles are HTML-entity-decoded.
  Dated items matching a live event's title (any case), city, date and time are duplicates
  regardless of source string. `review_rules.action` is `skip` (exact title key) or
  `skip_contains` (key substring). Learned skips count only rejections after the latest approval.
  The admin review queue groups repeats (same source, title, start time) into one card.
- Verification flags "possibly cancelled" and "time changed". It skips sources
  that return 0 events and matches titles loosely (`sameEventTitle`).

## Product notes
- Coverage area: Boulder County towns plus Broomfield, Westminster, Arvada, Thornton
  and Mead. City filter is built from the data.
- Admin: `public/admin.html` (unlisted). Left-rail views (bottom tabs on phones):
  Today, Review, Pipeline, Growth, Experiments, Content, Digest. Today is built
  from existing endpoints; its Coverage runway ranks sources using the `priority`
  and `ease` fields `/api/source-freshness` adds (`enrichSourcesForTriage`).
  Keep every card's element ids when moving things: the loaders write into them.
- Weekly stats are week-to-date (the visitor-hash salt rotates Monday midnight MT),
  so `/api/stats` compares against the same elapsed time last week, not the full week.
- Recommended-section A/B test: 50/50 random split. Read at **80% confidence**
  (p < 0.20) with 80% power. These are directional reads.
- The owner's goal metric is daily active users; Google Analytics is the source of truth.
