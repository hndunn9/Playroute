// src/pipeline.js
//
// Single registry-driven scraping + validation + pending-queue pipeline.
// Every automated source funnels through ingestCandidate() into
// pending_events. Nothing reaches the live `events` table except a human
// approval (handleApprovePending in index.js), which re-runs validation
// server-side before publishing — so an emailed approve-link tap can't push
// a broken event live even if it looked fine when it was first queued.
//
// Replaces: INGEST_REVIEW_MODE (retired), publishEvent/queuePendingEvent
// (folded into ingestCandidate), and the split between /api/scrape-now and
// /api/pending-scan-now (folded into runSources()).

const VALID_CATEGORIES = ["library", "rec", "museum", "outdoor", "community", "farmers_market"];
const VALID_COSTS = ["free", "paid"];
const VALID_RECURRENCE_PREFIXES = ["dated", "weekly", "irregular", "monthly-"];

// Builds a dedup key that stays STABLE across repeated scans of the same
// underlying recurring program.
//
// Real bug this fixes (found 2026-07-14): the old per-source dedup keys were
// built from that scan's scraped URL path. Some library calendar platforms
// (confirmed with Lyons and, almost certainly, Westminster — same "Library
// Market"-family software) mint a NEW distinct URL for every date instance
// of a recurring program rather than one stable URL per series. That meant
// a weekly "Storytime" got queued as a brand-new "pending" item every single
// week it was rescanned — so approving or rejecting one week's copy never
// stuck, since next week's rescan created a fresh duplicate under a new key.
//
// The fix: key on title+city+day (or title+city+date for one-off events)
// instead of anything scraped from the page itself. This is exactly what
// stays constant across rescans of "the same" program.
function buildStableDedupKey(sourceKey, ev) {
  const norm = (s) => String(s || "").toLowerCase().trim().replace(/\s+/g, "-");
  // Real gap found 2026-07-14: title+city+day alone isn't a unique enough
  // identity — generic titles like "Storytime" legitimately recur at
  // several different times/locations under the exact same name. Without
  // start_time and location in the key, two genuinely distinct sessions
  // would collide and one would silently vanish via ON CONFLICT DO NOTHING.
  const time = norm(ev.start_time) || "?";
  const location = norm(ev.source) || "?";
  if (ev.recurrence === "dated" && ev.event_date) {
    return `${sourceKey}:${norm(ev.title)}:${norm(ev.city)}:${ev.event_date}:${time}:${location}`;
  }
  return `${sourceKey}:${norm(ev.title)}:${norm(ev.city)}:${norm(ev.day_of_week) || "?"}:${time}:${location}`;
}

// Validates one candidate event against the real `events` table constraints
// plus a handful of "does this look trustworthy" heuristics. Returns
// { severity: 'error'|'warn'|'clean', issues: [{level, reason}] }.
//
// 'error' issues mean the row would either violate a DB constraint or is
// missing information a person genuinely needs to fill in — these BLOCK
// one-tap approval in the admin panel until fixed. 'warn' issues are shown
// but stay approvable, since they're judgment calls, not hard blockers.
function validateCandidate(ev, sourceRow) {
  const issues = [];
  const err = (reason) => issues.push({ level: "error", reason });
  const warn = (reason) => issues.push({ level: "warn", reason });

  // Required fields, mirroring the events table's NOT NULL columns.
  const required = ["title", "city", "category", "cost", "start_time", "display_time", "recurrence", "source_url", "day_of_week"];
  for (const field of required) {
    if (ev[field] === undefined || ev[field] === null || ev[field] === "") {
      err(`Missing required field: ${field}`);
    }
  }

  // Recurrence / day-of-week / event_date must agree with each other.
  // Real gap found 2026-07-14: day_of_week is NOT NULL on the real `events`
  // table for every row, including dated ones (used for display, e.g.
  // "Saturday, July 11") — a WOW Museum candidate with day_of_week left
  // unset made it all the way through validation and only failed at the
  // database itself when approved. Moved day_of_week into the universally-
  // required list above so this is now caught the moment a candidate is
  // queued, not silently deferred to approval time.
  const recurrence = ev.recurrence || "";
  const isDated = recurrence === "dated";
  if (isDated && !ev.event_date) err(`recurrence is "dated" but event_date is missing`);
  if (ev.event_date && !isDated) err(`event_date is set but recurrence is "${recurrence || "(empty)"}", not "dated"`);
  if (recurrence && !VALID_RECURRENCE_PREFIXES.some((p) => recurrence === p || recurrence.startsWith(p))) {
    warn(`recurrence "${recurrence}" doesn't match a known pattern`);
  }

  // Enum validity — these have real CHECK constraints in the DB, so a bad
  // value here isn't just sloppy data, it will fail the actual insert.
  if (ev.category && !VALID_CATEGORIES.includes(ev.category)) {
    err(`category "${ev.category}" isn't one of: ${VALID_CATEGORIES.join(", ")}`);
  }
  if (ev.cost && !VALID_COSTS.includes(ev.cost)) {
    err(`cost "${ev.cost}" isn't one of: ${VALID_COSTS.join(", ")}`);
  }

  // Time confidence.
  if (ev.display_time === "Check listing for time" || ev.display_time === "See source for time") {
    err("display_time is a placeholder — no real time was parsed from the source");
  }
  if (ev._assumedTime) {
    warn(`start_time (${ev.start_time}) is a hardcoded fallback, not parsed from the source — confirm before trusting`);
  }

  // Date sanity, dated events only.
  if (isDated && ev.event_date) {
    const d = new Date(`${ev.event_date}T12:00:00Z`);
    if (isNaN(d.getTime())) {
      err(`event_date "${ev.event_date}" isn't a valid date`);
    } else {
      const daysOut = (d - new Date()) / 86400000;
      if (daysOut < -1) warn(`event_date (${ev.event_date}) is in the past`);
      if (daysOut > 120) warn(`event_date (${ev.event_date}) is more than 120 days out — confirm this wasn't a parsing error`);
    }
  }
  if (ev.season_start && !/^\d{2}-\d{2}$/.test(ev.season_start)) warn("season_start isn't in MM-DD format");
  if (ev.season_end && !/^\d{2}-\d{2}$/.test(ev.season_end)) warn("season_end isn't in MM-DD format");

  // Age sanity.
  if (typeof ev.age_min === "number" && typeof ev.age_max === "number" && ev.age_min > ev.age_max) {
    err(`age_min (${ev.age_min}) is greater than age_max (${ev.age_max})`);
  }
  if (ev._ageGuessed) {
    warn(`age range (${ev.age_min}\u2013${ev.age_max}) is a fallback guess, not parsed from real text`);
  }

  // Source-level confidence — a source flagged 'review' means its parsing
  // hasn't been fully verified against real pages yet, regardless of how
  // clean any individual item looks.
  if (sourceRow && sourceRow.confidence === "review") {
    warn(`source "${sourceRow.platform || sourceRow.city}" is flagged review-confidence \u2014 parsing not yet fully verified`);
  }
  if (sourceRow && sourceRow.confidence === "mixed") {
    warn(`source "${sourceRow.platform || sourceRow.city}" mixes confident and best-effort parsing \u2014 double check this one`);
  }

  const severity = issues.some((i) => i.level === "error") ? "error" : issues.length ? "warn" : "clean";
  return { severity, issues };
}

// Duplicate-risk check against the live `events` table — separate from the
// dedup_key mechanism (which prevents re-queuing the same pending candidate
// repeatedly). This catches the case where something was already approved
// under a slightly different dedup_key history, or manually entered by hand.
async function checkDuplicateRisk(env, ev) {
  // Real gap found 2026-07-14: title+city alone is far too loose — a
  // generic recurring title (e.g. "Storytime") legitimately has many
  // distinct real sessions at different days/times/locations under the
  // exact same city+title. Matching only on title+city meant a genuinely
  // new session would get silently treated as "already exists" and never
  // even reach the review queue. Now matches on the same identity that
  // actually determines "is this the same real-world event slot": title,
  // city, day-or-date, start_time, and source (location).
  const isDated = ev.recurrence === "dated" && ev.event_date;
  const conditions = ["title = ?", "city = ?", "start_time = ?"];
  const binds = [ev.title, ev.city, ev.start_time];
  if (isDated) {
    conditions.push("event_date = ?");
    binds.push(ev.event_date);
  } else if (ev.day_of_week) {
    conditions.push("day_of_week = ?");
    binds.push(ev.day_of_week);
  }
  if (ev.source) {
    conditions.push("source = ?");
    binds.push(ev.source);
  }
  const row = await env.DB.prepare(
    `SELECT 1 FROM events WHERE ${conditions.join(" AND ")} LIMIT 1`
  ).bind(...binds).first();
  return !!row;
}

// normalize -> validate -> dedupe -> insert into pending_events.
// sourceRow is the scrape_sources row this candidate came from (or null for
// ad-hoc/external ingest via /api/ingest).
async function ingestCandidate(env, sourceRow, ev) {
  const sourceKey = (sourceRow && sourceRow.source_key) || "unknown";

  const alreadyLive = await checkDuplicateRisk(env, ev);
  if (alreadyLive) {
    return { queued: false, reason: "duplicate-in-events" };
  }

  const { severity, issues } = validateCandidate(ev, sourceRow);
  const dedupKey = ev.dedup_key || buildStableDedupKey(sourceKey, ev);
  const token = crypto.randomUUID();

  const res = await env.DB.prepare(
    `INSERT INTO pending_events
      (title, source, city, category, cost, age_min, age_max, day_of_week,
       event_date, start_time, display_time, recurrence, note, source_url,
       raw_excerpt, dedup_key, approval_token, severity, validation_notes, source_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(dedup_key) DO NOTHING`
  ).bind(
    ev.title, ev.source ?? null, ev.city ?? null, ev.category ?? null, ev.cost ?? null,
    ev.age_min ?? null, ev.age_max ?? null, ev.day_of_week ?? null, ev.event_date ?? null,
    ev.start_time ?? null, ev.display_time ?? null, ev.recurrence ?? null, ev.note ?? null,
    ev.source_url ?? null, ev.note ?? null, dedupKey, token, severity,
    JSON.stringify(issues), sourceRow ? sourceRow.id : null
  ).run();

  return { queued: res.meta.changes > 0, severity, issues };
}

// Registered by index.js: sourceKey -> async fn(env, sourceRow) -> array of
// raw candidate events (in the same shape ingestCandidate expects).
// Kept here as an empty object that index.js populates, so pipeline.js
// doesn't need to import every individual scraper function directly —
// avoids a circular-import mess between the two files.
const SOURCE_RUNNERS = {};

// Runs every enabled, mode='auto' source matching `cadence` (or all of them
// if cadence is omitted — that's what the admin panel's single button
// does). Every result funnels through ingestCandidate; nothing here ever
// writes to `events` directly. Stamps last_run_at/last_status/last_error/
// last_found on scrape_sources for each source it touches.
async function runSources(env, { cadence = null } = {}) {
  const where = cadence
    ? `WHERE mode = 'auto' AND enabled = 1 AND cadence = ?`
    : `WHERE mode = 'auto' AND enabled = 1`;
  const binds = cadence ? [cadence] : [];
  const { results: sources } = await env.DB.prepare(
    `SELECT * FROM scrape_sources ${where}`
  ).bind(...binds).all();

  const summary = [];
  for (const source of sources) {
    const runner = SOURCE_RUNNERS[source.source_key];
    if (!runner) {
      summary.push({ source: source.source_key || source.platform, status: "error", error: "no_runner_registered" });
      continue;
    }
    try {
      const candidates = await runner(env, source);
      let queued = 0, skippedDuplicate = 0, errors = 0, warnings = 0;
      for (const ev of candidates) {
        const result = await ingestCandidate(env, source, ev);
        if (result.reason === "duplicate-in-events") { skippedDuplicate++; continue; }
        if (result.queued) {
          queued++;
          if (result.severity === "error") errors++;
          else if (result.severity === "warn") warnings++;
        }
      }
      await env.DB.prepare(
        `UPDATE scrape_sources SET last_run_at = CURRENT_TIMESTAMP, last_run_status = 'ok', last_error = NULL, last_found = ? WHERE id = ?`
      ).bind(candidates.length, source.id).run();
      summary.push({ source: source.source_key, status: "ok", found: candidates.length, queued, skippedDuplicate, errors, warnings });
    } catch (e) {
      await env.DB.prepare(
        `UPDATE scrape_sources SET last_run_at = CURRENT_TIMESTAMP, last_run_status = 'error', last_error = ? WHERE id = ?`
      ).bind(String(e), source.id).run();
      summary.push({ source: source.source_key, status: "error", error: String(e) });
    }
  }
  return summary;
}

export { validateCandidate, buildStableDedupKey, checkDuplicateRisk, ingestCandidate, runSources, SOURCE_RUNNERS, VALID_CATEGORIES, VALID_COSTS };
