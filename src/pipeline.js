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
  if (row) return { isDuplicate: true };

  // Fourth gap found 2026-10-01: Boulder's live storytimes were entered by
  // hand or from the library's iCal feed with a different source string than
  // the LibCal scraper uses, so the exact match above (which includes source)
  // missed them and ~40 duplicates reached the queue. A dated slot with the
  // same title (case-insensitive), city, date and start time is the same
  // session no matter which source string it carries.
  if (isDated) {
    const anySource = await env.DB.prepare(
      `SELECT 1 FROM events WHERE lower(title) = lower(?) AND city = ? AND event_date = ? AND start_time = ? LIMIT 1`
    ).bind(ev.title, ev.city, ev.event_date, ev.start_time).first();
    if (anySource) return { isDuplicate: true };
  }

  // Third gap found 2026-09-25: a DATED candidate that falls on a slot a
  // live WEEKLY row already covers (same title, city, weekday, start time)
  // is a duplicate -- e.g. Lafayette's iCal feed lists every Tuesday's
  // "Baby Storytime" as its own dated occurrence, while the site already
  // shows it as one weekly event. The exact match above never compared
  // dated vs. weekly, and the location string also differed slightly
  // ("Meeting Room" vs "Meeting Room, Lafayette Library"), so every week
  // got queued again. Location is deliberately NOT compared here: title +
  // city + weekday + time is already specific enough, and room names drift.
  // Respects season_start/season_end (MM-DD) on the weekly row if set.
  if (isDated && ev.day_of_week) {
    const mmdd = String(ev.event_date).slice(5);
    const weekly = await env.DB.prepare(
      `SELECT 1 FROM events
        WHERE recurrence = 'weekly' AND title = ? AND city = ? AND day_of_week = ? AND start_time = ?
          AND (season_start IS NULL OR season_end IS NULL
               OR (season_start <= season_end AND ? BETWEEN season_start AND season_end)
               OR (season_start > season_end AND (? >= season_start OR ? <= season_end)))
        LIMIT 1`
    ).bind(ev.title, ev.city, ev.day_of_week, ev.start_time, mmdd, mmdd, mmdd).first();
    if (weekly) return { isDuplicate: true };
  }

  // Second gap found 2026-07-17: the exact-time match above is correct for
  // telling genuinely different sessions apart, but it has a side effect --
  // if a source's reported time for the SAME real date changes (schedule
  // change, or us correcting a past scraper bug like the 6-hour timezone
  // issue), the new time doesn't match the old row and sails through as a
  // clean "new" candidate, creating an invisible duplicate once approved
  // (this exact thing happened to "Erie Tales for Tots Storytime"). Flag
  // it as a warning instead of silently missing it, without fully blocking
  // approval -- it might be a legitimate schedule change, not a bug.
  if (isDated) {
    const sameDayDifferentTime = await env.DB.prepare(
      `SELECT start_time FROM events WHERE title = ? AND city = ? AND event_date = ? LIMIT 1`
    ).bind(ev.title, ev.city, ev.event_date).first();
    if (sameDayDifferentTime) {
      return { isDuplicate: false, possibleTimeConflict: sameDayDifferentTime.start_time };
    }
  }
  return { isDuplicate: false };
}


// ---------------------------------------------------------------------------
// BULK PRELOAD (2026-10-01). checkDuplicateRisk costs 2-4 D1 queries per
// candidate, plus one INSERT each. A source with ~250 candidates (Boulder on
// Communico) blew through the Free plan's 1,000-subrequest cap mid-run, so
// the run died without recording itself. runSources now loads, once:
//   - every dedup_key already seen for this source (pending/approved/rejected),
//     so already-known candidates skip the INSERT entirely, and
//   - a live-events index for the candidates' cities,
// and checks duplicates in memory with the same rules as checkDuplicateRisk.
// ---------------------------------------------------------------------------
async function preloadIngestIndex(env, sourceRow, candidates) {
  const cities = [...new Set((candidates || []).map((c) => c.city).filter(Boolean))];
  const existingKeys = new Set();
  if (sourceRow && sourceRow.id) {
    const { results } = await env.DB.prepare(
      `SELECT dedup_key FROM pending_events WHERE source_id = ? AND dedup_key IS NOT NULL`
    ).bind(sourceRow.id).all();
    for (const r of results || []) existingKeys.add(r.dedup_key);
  }
  if (!cities.length) return { existingKeys, live: null };
  const { results: rows } = await env.DB.prepare(
    `SELECT title, city, event_date, start_time, day_of_week, recurrence, source, season_start, season_end
       FROM events WHERE city IN (${cities.map(() => "?").join(",")})
        AND (recurrence = 'weekly' OR event_date IS NULL OR event_date >= date('now', '-1 day'))`
  ).bind(...cities).all();
  const live = { exact: new Set(), datedAny: new Set(), weekly: new Map(), sameDay: new Map() };
  for (const e of rows || []) {
    const lt = String(e.title || "").toLowerCase();
    live.exact.add([e.title, e.city, e.start_time, e.recurrence === "dated" ? e.event_date : e.day_of_week, e.source].join("|"));
    if (e.event_date) {
      live.datedAny.add([lt, e.city, e.event_date, e.start_time].join("|"));
      const dk = [e.title, e.city, e.event_date].join("|");
      if (!live.sameDay.has(dk)) live.sameDay.set(dk, e.start_time);
    }
    if (e.recurrence === "weekly") {
      const wk = [e.title, e.city, e.day_of_week, e.start_time].join("|");
      if (!live.weekly.has(wk)) live.weekly.set(wk, []);
      live.weekly.get(wk).push(e);
    }
  }
  return { existingKeys, live };
}

function inSeason(mmdd, start, end) {
  if (!start || !end) return true;
  return start <= end ? (mmdd >= start && mmdd <= end) : (mmdd >= start || mmdd <= end);
}

// Same rules as checkDuplicateRisk, answered from the preloaded index.
function checkDuplicateRiskIndexed(live, ev) {
  const isDated = ev.recurrence === "dated" && ev.event_date;
  const slot = isDated ? ev.event_date : ev.day_of_week;
  if (ev.source && live.exact.has([ev.title, ev.city, ev.start_time, slot, ev.source].join("|"))) return { isDuplicate: true };
  if (isDated && live.datedAny.has([String(ev.title || "").toLowerCase(), ev.city, ev.event_date, ev.start_time].join("|"))) return { isDuplicate: true };
  if (isDated && ev.day_of_week) {
    const weekly = live.weekly.get([ev.title, ev.city, ev.day_of_week, ev.start_time].join("|")) || [];
    const mmdd = String(ev.event_date).slice(5);
    if (weekly.some((w) => inSeason(mmdd, w.season_start, w.season_end))) return { isDuplicate: true };
  }
  if (isDated) {
    const t = live.sameDay.get([ev.title, ev.city, ev.event_date].join("|"));
    if (t) return { isDuplicate: false, possibleTimeConflict: t };
  }
  return { isDuplicate: false };
}

// ---------------------------------------------------------------------------
// REVIEW FEEDBACK LOOP (2026-09-25)
//
// Every approve/reject in the review queue is a label on "what good looks
// like". Before this, a rejection only stopped that one exact item (its
// dedup_key) from coming back -- next week's date of the same unwanted
// program was queued again, and nothing recorded WHY it was rejected.
//
// Now:
//  1. Rejections carry a reason (REJECT_REASONS). Item-level reasons
//     ("not for kids", "not relevant") describe the PROGRAM; scraper-level
//     reasons ("wrong details", "broken link") describe a SCRAPER BUG and
//     roll up into per-source quality stats instead of hiding the item.
//  2. Explicit rules: rejecting with "skip this program in future" writes a
//     review_rules row; matching candidates from that source are dropped.
//  3. Learned rules: a program from a source rejected >= 2 times for an
//     item-level reason with zero approvals is dropped automatically.
//  4. Everything else that has history gets an info note ("you approved
//     6 of 6 past ...") so the queue shows what you've decided before.
// Nothing here ever auto-PUBLISHES -- learning only removes noise or adds
// context. Approval stays a human decision.
// ---------------------------------------------------------------------------
const REJECT_REASONS = {
  not_for_kids: { label: "Not for kids / wrong ages", itemLevel: true },
  not_relevant: { label: "Not relevant / not a real event", itemLevel: true },
  duplicate: { label: "Duplicate of something already live", itemLevel: false },
  wrong_details: { label: "Wrong date, time, or place", itemLevel: false },
  bad_link: { label: "Broken or wrong link", itemLevel: false },
  other: { label: "Other", itemLevel: false }
};
const ITEM_LEVEL_REASONS = Object.keys(REJECT_REASONS).filter((k) => REJECT_REASONS[k].itemLevel);
const LEARNED_SKIP_MIN_REJECTIONS = 2;

// Normalized program identity, stable across dates/rooms: lowercase,
// punctuation stripped, whitespace collapsed.
function titleKey(title) {
  return String(title || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Loads everything applyReviewHistory needs for ONE source in two queries,
// so a 271-event run doesn't add 500+ database calls (the Free plan caps
// Cloudflare-service subrequests at 1,000 per invocation).
async function loadReviewContext(env, sourceRow) {
  if (!sourceRow || !sourceRow.id) return null;
  const [{ results: rules }, { results: hist }] = await Promise.all([
    env.DB.prepare(
      `SELECT id, title_key, action FROM review_rules WHERE action IN ('skip', 'skip_contains') AND (source_id = ? OR source_id IS NULL)`
    ).bind(sourceRow.id).all(),
    env.DB.prepare(
      `SELECT title, status, reject_reason, decided_at FROM pending_events
        WHERE source_id = ? AND change_type IS NULL AND status IN ('approved','rejected')
        ORDER BY decided_at`
    ).bind(sourceRow.id).all()
  ]);
  const rulesByKey = new Map((rules || []).filter((r) => r.action === "skip").map((r) => [r.title_key, r.id]));
  // skip_contains: drop any title whose normalized key CONTAINS the rule's
  // key, so "kids caf" also catches "Kids Café at Brighton".
  const containsRules = (rules || []).filter((r) => r.action === "skip_contains" && r.title_key);
  const histByKey = new Map();
  for (const r of hist || []) {
    const k = titleKey(r.title);
    if (!histByKey.has(k)) histByKey.set(k, []);
    histByKey.get(k).push(r);
  }
  return { rulesByKey, containsRules, histByKey, ruleHits: new Map() };
}

// Records rule hits gathered during a run (one query per rule that fired).
async function flushRuleHits(env, ctx) {
  if (!ctx || !ctx.ruleHits) return;
  for (const [id, n] of ctx.ruleHits) {
    await env.DB.prepare(
      `UPDATE review_rules SET hits = hits + ?, last_hit_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).bind(n, id).run();
  }
}

// Returns { skip: true, why } or { skip: false, note } for one candidate.
function applyReviewHistory(ctx, ev) {
  if (!ctx || !ctx.rulesByKey || !ev.title) return { skip: false };
  const key = titleKey(ev.title);

  const contains = (ctx.containsRules || []).find((r) => key.includes(r.title_key));
  const ruleId = ctx.rulesByKey.get(key) || (contains && contains.id);
  if (ruleId) {
    ctx.ruleHits.set(ruleId, (ctx.ruleHits.get(ruleId) || 0) + 1);
    return { skip: true, why: "rule" };
  }

  const hist = ctx.histByKey.get(key) || [];
  if (!hist.length) return { skip: false };

  const approved = hist.filter((r) => r.status === "approved").length;
  const rejected = hist.filter((r) => r.status === "rejected");
  // Only decisions AFTER the most recent approval count, so changing your
  // mind (approved once, then rejected it twice) still teaches the skip.
  // hist is ordered by decided_at.
  let lastApproval = -1;
  hist.forEach((r, i) => { if (r.status === "approved") lastApproval = i; });
  const itemLevelRejects = hist.slice(lastApproval + 1)
    .filter((r) => r.status === "rejected" && ITEM_LEVEL_REASONS.includes(r.reject_reason)).length;
  if (itemLevelRejects >= LEARNED_SKIP_MIN_REJECTIONS) {
    return { skip: true, why: "learned" };
  }

  const reasonCounts = {};
  for (const r of rejected) {
    const k = r.reject_reason || "no reason given";
    reasonCounts[k] = (reasonCounts[k] || 0) + 1;
  }
  const reasonText = Object.entries(reasonCounts)
    .map(([k, n]) => `${REJECT_REASONS[k] ? REJECT_REASONS[k].label.toLowerCase() : k} \u00d7${n}`)
    .join(", ");
  const note = rejected.length
    ? `History: you approved ${approved} and rejected ${rejected.length} past "${ev.title}" from this source${reasonText ? ` (${reasonText})` : ""}.`
    : `History: you approved all ${approved} past "${ev.title}" from this source.`;
  return { skip: false, note };
}

// ---------------------------------------------------------------------------
// CONTENT FILTERS (2026-10-01), built from the review history: of ~300
// rejections, most were teen/tween programs, adult talks tagged with a
// default 0-18 age range, placeholder titles, and registration-only
// "buddies" series. Anything matching is dropped before it reaches the
// queue. An explicit kid/family signal in the title always wins over the
// adult-topic list, and ages 9+ stay only when the title says family/all ages.
// Measured on past decisions: ages 9+ were approved 4 times, rejected 86.
// ---------------------------------------------------------------------------
const KID_SIGNAL_RE = /\b(kids?|child|children|famil(y|ies)|toddlers?|bab(y|ies)|preschool(ers)?|story ?time|storytime|tots?|little ones?|caregivers?|parents?|all ages)\b/i;
const FAMILY_SIGNAL_RE = /\b(famil(y|ies)|all ages|caregivers?|parents? (and|&) (kids?|child))\b/i;
const TEEN_TITLE_RE = /\b(teens?|tweens?|grades? (6|7|8|9|1[0-2])|middle school|high school)\b/i;
const PLACEHOLDER_TITLE_RE = /\b(draft|tbd|tba)\b/i;
const REGISTRATION_SERIES_RE = /\bbuddies\b.*\bregister\b|[-–—:]\s*register\s*$/i;
const ADULT_TOPIC_RE = /\b(tech tuesday|orientation|book group|board meeting|genealogy|virtual training|book club|brew(ing|ery)|pints?|wine|beer|cocktails?|an evening with|lecture|ballots?|voters?|elections?|seed swap|tea of the month|grow your business|small business|resumes?|job search|medicare|retirement|estate planning|taxes)\b/i;

function decodeEntities(str) {
  if (!str || !/&(#\d+|#x[0-9a-f]+|[a-z]+);/i.test(str)) return str;
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…" };
  return String(str)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => named[n.toLowerCase()] ?? m);
}

// Returns a short reason string if the candidate should be dropped, else null.
function contentFilter(ev) {
  const title = String(ev.title || "");
  if (PLACEHOLDER_TITLE_RE.test(title)) return "placeholder-title";
  if (REGISTRATION_SERIES_RE.test(title)) return "registration-series";
  const familySignal = FAMILY_SIGNAL_RE.test(title);
  if (!familySignal && typeof ev.age_min === "number" && ev.age_min >= 9) return "teen-tween-ages";
  if (!familySignal && TEEN_TITLE_RE.test(title)) return "teen-tween-title";
  if (!KID_SIGNAL_RE.test(title) && ADULT_TOPIC_RE.test(title)) return "adult-topic";
  return null;
}

// normalize -> validate -> dedupe -> insert into pending_events.
// sourceRow is the scrape_sources row this candidate came from (or null for
// ad-hoc/external ingest via /api/ingest).
async function ingestCandidate(env, sourceRow, ev, reviewCtx = null) {
  const sourceKey = (sourceRow && sourceRow.source_key) || "unknown";
  ev.title = decodeEntities(ev.title);
  if (ev.note) ev.note = decodeEntities(ev.note);

  const filtered = contentFilter(ev);
  if (filtered) return { queued: false, reason: "filtered", filter: filtered };

  const history = applyReviewHistory(reviewCtx, ev);
  if (history.skip) {
    return { queued: false, reason: history.why === "rule" ? "skipped-by-rule" : "skipped-learned" };
  }

  const dedupKey = ev.dedup_key || buildStableDedupKey(sourceKey, ev);
  if (reviewCtx && reviewCtx.existingKeys && reviewCtx.existingKeys.has(dedupKey)) {
    return { queued: false, reason: "already-seen" };
  }

  const dupCheck = reviewCtx && reviewCtx.live
    ? checkDuplicateRiskIndexed(reviewCtx.live, ev)
    : await checkDuplicateRisk(env, ev);
  if (dupCheck.isDuplicate) {
    return { queued: false, reason: "duplicate-in-events" };
  }

  const { severity, issues } = validateCandidate(ev, sourceRow);
  if (dupCheck.possibleTimeConflict) {
    issues.push({
      level: "warn",
      reason: `Same title/city/date already exists in events at a different time (${dupCheck.possibleTimeConflict}) -- could be a legitimate schedule change, or a leftover from a since-corrected scrape. Worth checking before approving.`
    });
  }
  if (history.note) issues.push({ level: "info", reason: history.note });
  // "info" notes are context, not problems -- they don't change severity.
  const finalSeverity = issues.some((i) => i.level === "error") ? "error" : issues.some((i) => i.level === "warn") ? "warn" : "clean";

  // Error-severity candidates are never actually queued -- 2026-09 fix.
  // "error" here always means something a human CAN'T just accept or
  // reject as-is (a required field is missing, an enum value is invalid,
  // display_time is a literal placeholder) -- it needs manual data entry
  // first regardless, so queuing it just adds clutter to sort through.
  // "warn" is left queued on purpose: for a regular scraper (unlike the
  // LLM discovery pipeline, which drops both) a warn is typically a real,
  // actionable signal about a source a human already vetted -- e.g. a
  // schedule-conflict flag worth a second look -- not the scraper being
  // unsure whether something exists at all.
  if (finalSeverity === "error") {
    return { queued: false, reason: "blocked-by-validation", severity: finalSeverity, issues };
  }

  const token = crypto.randomUUID();

  const res = await env.DB.prepare(
    `INSERT INTO pending_events
      (title, source, city, category, cost, age_min, age_max, day_of_week,
       event_date, start_time, display_time, recurrence, note, source_url,
       raw_excerpt, dedup_key, approval_token, severity, validation_notes, source_id,
       season_start, season_end)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(dedup_key) DO NOTHING`
  ).bind(
    ev.title, ev.source ?? null, ev.city ?? null, ev.category ?? null, ev.cost ?? null,
    ev.age_min ?? null, ev.age_max ?? null, ev.day_of_week ?? null, ev.event_date ?? null,
    ev.start_time ?? null, ev.display_time ?? null, ev.recurrence ?? null, ev.note ?? null,
    ev.source_url ?? null, ev.note ?? null, dedupKey, token, finalSeverity,
    JSON.stringify(issues), sourceRow ? sourceRow.id : null,
    ev.season_start ?? null, ev.season_end ?? null
  ).run();

  return { queued: res.meta.changes > 0, severity: finalSeverity, issues };
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
async function runSources(env, { cadence = null, sourceKey = null } = {}) {
  // sourceKey: run exactly one source -- used by the per-source fan-out
  // (runSourcesFannedOut in index.js), where each source gets its own
  // Worker invocation and therefore its own subrequest budget.
  const where = sourceKey
    ? `WHERE mode = 'auto' AND enabled = 1 AND source_key = ?`
    : cadence
      ? `WHERE mode = 'auto' AND enabled = 1 AND cadence = ?`
      : `WHERE mode = 'auto' AND enabled = 1`;
  const binds = sourceKey ? [sourceKey] : cadence ? [cadence] : [];
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
      const reviewCtx = (await loadReviewContext(env, source)) || {};
      Object.assign(reviewCtx, await preloadIngestIndex(env, source, candidates));
      let queued = 0, skippedDuplicate = 0, blockedInvalid = 0, warnings = 0, skippedByReview = 0, filtered = 0, alreadySeen = 0;
      for (const ev of candidates) {
        const result = await ingestCandidate(env, source, ev, reviewCtx);
        if (result.reason === "duplicate-in-events") { skippedDuplicate++; continue; }
        if (result.reason === "already-seen") { alreadySeen++; continue; }
        if (result.reason === "blocked-by-validation") { blockedInvalid++; continue; }
        if (result.reason === "skipped-by-rule" || result.reason === "skipped-learned") { skippedByReview++; continue; }
        if (result.reason === "filtered") { filtered++; continue; }
        if (result.queued) {
          queued++;
          if (result.severity === "warn") warnings++;
        }
      }
      await flushRuleHits(env, reviewCtx);
      await env.DB.prepare(
        `UPDATE scrape_sources SET last_run_at = CURRENT_TIMESTAMP, last_run_status = 'ok', last_error = NULL, last_found = ? WHERE id = ?`
      ).bind(candidates.length, source.id).run();
      summary.push({ source: source.source_key, status: "ok", found: candidates.length, queued, skippedDuplicate, blockedInvalid, skippedByReview, filtered, alreadySeen, warnings });
    } catch (e) {
      await env.DB.prepare(
        `UPDATE scrape_sources SET last_run_at = CURRENT_TIMESTAMP, last_run_status = 'error', last_error = ? WHERE id = ?`
      ).bind(String(e), source.id).run();
      summary.push({ source: source.source_key, status: "error", error: String(e) });
    }
  }
  return summary;
}

export { REJECT_REASONS, preloadIngestIndex, checkDuplicateRiskIndexed, titleKey, contentFilter, decodeEntities, loadReviewContext, applyReviewHistory, validateCandidate, buildStableDedupKey, checkDuplicateRisk, ingestCandidate, runSources, SOURCE_RUNNERS, VALID_CATEGORIES, VALID_COSTS };
