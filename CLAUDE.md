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
- Boulder library iCal dedup keys include the room/source string. If the library
  renames a room, old and new rows can duplicate. Clean up by keeping the newer spelling.
- **JS-rendered platforms** (WellnessLiving, Arketa, iClassPro) can't be read with
  `fetch()`. WellnessLiving's API needs a per-request signature, so use the
  Browser Run binding (`env.BROWSER`) via `browserRun()` and read the
  widget iframe (`runWellnessLivingStudio`).
- Verification flags "possibly cancelled" and "time changed". It skips sources
  that return 0 events and matches titles loosely (`sameEventTitle`).

## Product notes
- Coverage area: Boulder County towns plus Broomfield, Westminster, Arvada, Thornton
  and Mead. City filter is built from the data.
- Admin: `public/admin.html` (unlisted). It shows the pending queue, coverage
  alerts, manual-source gaps, the source and city freshness panel, and the
  recommended A/B test.
- Recommended-section A/B test: 50/50 random split. Read at **80% confidence**
  (p < 0.20) with 80% power. These are directional reads.
- The owner's goal metric is daily active users; Google Analytics is the source of truth.
