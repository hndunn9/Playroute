// ===== playroute-worker bundle — includes Mountain Time timezone fix Jul 2 2026 =====

// --- occurrence.js ---
/**
 * Computes each event's next real occurrence so the API can filter out
 * anything already passed and sort everything chronologically.
 *
 * TIMEZONE FIX (Jul 2 2026): all stored times are Mountain Time. The
 * original code treated them as UTC, which caused events to drop from
 * the feed 6 hours early (MDT=UTC-6) — e.g. a 10:15 AM Mountain event
 * was considered expired at 4:15 AM Mountain time. Fixed by resolving
 * stored times as America/Denver wall-clock time before comparing to now.
 */

const DAY_INDEX = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
const TZ = "America/Denver";

/** Convert a stored date string + hh/mm into the correct UTC timestamp
 *  for that wall-clock time in Mountain Time (handles DST automatically). */
function toMountainDate(dateStr, hh, mm) {
  try {
    const ref = new Date(`${dateStr}T12:00:00Z`);
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: TZ, year:"numeric", month:"2-digit", day:"2-digit",
      hour:"2-digit", minute:"2-digit", second:"2-digit", hour12:false
    }).formatToParts(ref);
    const p = Object.fromEntries(parts.filter(x=>x.type!=="literal").map(x=>[x.type,+x.value]));
    const utcOffsetMs = ref.getTime() - Date.UTC(p.year, p.month-1, p.day, p.hour%24, p.minute, p.second);
    return new Date(
      Date.UTC(+dateStr.slice(0,4), +dateStr.slice(5,7)-1, +dateStr.slice(8,10), hh, mm, 0)
      + utcOffsetMs
    );
  } catch {
    // Fallback: assume MDT (UTC-6), correct for summer season
    return new Date(Date.UTC(
      +dateStr.slice(0,4), +dateStr.slice(5,7)-1, +dateStr.slice(8,10),
      hh + 6, mm, 0
    ));
  }
}

/** Get the date string for a UTC Date in Mountain Time. */
function toMountainDateStr(date) {
  return date.toLocaleDateString("en-US", {
    timeZone: TZ, year:"numeric", month:"2-digit", day:"2-digit"
  }).replace(/(\d+)\/(\d+)\/(\d+)/, "$3-$1-$2");
}

function lastSundayOfMonth(year, month) {
  const d = new Date(Date.UTC(year, month + 1, 0));
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d;
}

function getNextMonthlyLastSunday(startTime, now) {
  const [hh, mm] = startTime.split(":").map(Number);
  // Work in Mountain Time to find the right month
  const nowMT = new Date(now.toLocaleString("en-US", { timeZone: TZ }));
  let year = nowMT.getFullYear(), month = nowMT.getMonth();
  let sunday = lastSundayOfMonth(year, month);
  let candidate = toMountainDate(sunday.toISOString().slice(0,10), hh, mm);
  if (candidate < now) {
    month++;
    if (month > 11) { month = 0; year++; }
    sunday = lastSundayOfMonth(year, month);
    candidate = toMountainDate(sunday.toISOString().slice(0,10), hh, mm);
  }
  return candidate;
}

function getNextWeeklyOccurrence(dayName, startTime, now) {
  const [hh, mm] = startTime.split(":").map(Number);
  const targetIdx = DAY_INDEX[dayName];
  if (targetIdx === undefined) return null;

  // Find current day-of-week in Mountain Time
  const nowDowMT = new Date(now.toLocaleString("en-US", { timeZone: TZ })).getDay();
  let diff = (targetIdx - nowDowMT + 7) % 7;

  // Build today's date string in Mountain Time
  const todayMT = toMountainDateStr(now);
  const todayMs = new Date(todayMT + "T12:00:00Z").getTime();
  const candidateDateStr = new Date(todayMs + diff * 86400000).toISOString().slice(0,10);
  let candidate = toMountainDate(candidateDateStr, hh, mm);

  if (diff === 0 && candidate < now) {
    const nextDateStr = new Date(todayMs + 7 * 86400000).toISOString().slice(0,10);
    candidate = toMountainDate(nextDateStr, hh, mm);
  }
  return candidate;
}

function getDatedOccurrence(eventDate, startTime) {
  if (!eventDate) return null;
  const [hh, mm] = (startTime || "00:00").split(":").map(Number);
  const result = toMountainDate(eventDate, hh, mm);
  return isNaN(result.getTime()) ? null : result;
}

function isInSeason(seasonStart, seasonEnd, date) {
  if (!seasonStart || !seasonEnd) return true;
  const dateMT = new Date(date.toLocaleString("en-US", { timeZone: TZ }));
  const dateMD = (dateMT.getMonth() + 1) * 100 + dateMT.getDate();
  const [sm, sd] = seasonStart.split("-").map(Number);
  const [em, ed] = seasonEnd.split("-").map(Number);
  const startMD = sm * 100 + sd, endMD = em * 100 + ed;
  if (startMD <= endMD) return dateMD >= startMD && dateMD <= endMD;
  return dateMD >= startMD || dateMD <= endMD;
}

function getOccurrence(ev, now = new Date()) {
  let occ;
  if (ev.recurrence === "dated") {
    occ = getDatedOccurrence(ev.event_date, ev.start_time);
    if (!occ || occ < now) return null;
  } else if (ev.recurrence === "monthly-last-sunday") {
    occ = getNextMonthlyLastSunday(ev.start_time, now);
  } else if (ev.recurrence === "irregular") {
    return null;
  } else {
    occ = getNextWeeklyOccurrence(ev.day_of_week, ev.start_time, now);
  }
  if (occ && !isInSeason(ev.season_start, ev.season_end, occ)) return null;
  return occ;
}

function formatOccurrenceLabel(date) {
  if (!date) return null;
  const weekday = date.toLocaleDateString("en-US", { weekday: "long", timeZone: TZ });
  const md = date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: TZ });
  return `${weekday} · ${md}`;
}

function ageMatchesBucket(ev, bucketId) {
  if (!bucketId || bucketId === "all") return true;
  const [lo, hi] = bucketId.split("-").map(Number);
  return ev.age_max >= lo && ev.age_min <= hi;
}


// --- libcal.js ---
/**
 * LibCal API client.
 *
 * LibCal's public Events API (v1.1) requires OAuth2 client-credentials auth.
 * Each library system issues its own client_id/client_secret — you have to
 * request these from the library's LibCal admin (usually IT or the library
 * director). This is the officially supported integration path, not a
 * scrape of the public calendar HTML.
 *
 * Docs pattern (Springshare LibCal API v1.1):
 *   POST {base}/1.1/oauth/token   — get access token
 *   GET  {base}/1.1/events        — list events for a calendar
 */

async function getAccessToken(env, base, clientId, clientSecret, cacheKey) {
  // Reuse a cached token if we have one and it's not expired (KV is optional —
  // works fine without it, just re-authenticates every run).
  if (env.TOKEN_CACHE) {
    const cached = await env.TOKEN_CACHE.get(cacheKey, { type: "json" });
    if (cached && cached.expires > Date.now()) return cached.token;
  }

  const res = await fetch(`${base}/1.1/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!res.ok) {
    throw new Error(`LibCal auth failed for ${base}: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const token = data.access_token;
  const expiresInMs = (data.expires_in || 3600) * 1000;

  if (env.TOKEN_CACHE) {
    await env.TOKEN_CACHE.put(
      cacheKey,
      JSON.stringify({ token, expires: Date.now() + expiresInMs - 30000 }),
      { expirationTtl: Math.max(60, Math.floor(expiresInMs / 1000)) }
    );
  }

  return token;
}

async function fetchLibCalEvents(base, token, calId, days = 14) {
  const url = `${base}/1.1/events?cal_id=${encodeURIComponent(calId)}&days=${days}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

  if (!res.ok) {
    throw new Error(`LibCal events fetch failed for cal_id=${calId}: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  // The API sometimes returns { events: [...] } and sometimes a bare array —
  // handle both defensively.
  return Array.isArray(data) ? data : data.events || [];
}

/**
 * Maps a raw LibCal event object onto our `events` table schema.
 * LibCal's age-tagging is inconsistent across libraries, so this is a
 * best-effort inference from the "audience" tags — worth spot-checking
 * against real data once you have live credentials, since exact tag
 * vocabulary varies by library system.
 */
function normalizeEvent(raw, cityName, timeZone = "America/Denver") {
  const start = new Date(raw.start);

  const dayOfWeek = start.toLocaleDateString("en-US", { weekday: "long", timeZone });
  const startTime = start.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  });
  const displayStart = start.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  });

  let displayTime = displayStart;
  if (raw.end) {
    const end = new Date(raw.end);
    const displayEnd = end.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone,
    });
    displayTime = `${displayStart} – ${displayEnd}`;
  }

  const audience = (raw.audience || [])
    .map((a) => (typeof a === "string" ? a : a.name || ""))
    .join(",")
    .toLowerCase();

  let ageMin = 0;
  let ageMax = 8;
  if (audience.includes("baby") || audience.includes("toddler")) {
    ageMin = 0;
    ageMax = 2;
  } else if (audience.includes("preschool")) {
    ageMin = 2;
    ageMax = 5;
  } else if (audience.includes("elementary")) {
    ageMin = 5;
    ageMax = 10;
  }

  const description = (raw.description || "").replace(/<[^>]+>/g, "").trim().slice(0, 300);

  return {
    title: raw.title,
    source: raw.location?.name || `${cityName} Public Library`,
    city: cityName,
    category: "library",
    cost: "free",
    age_min: ageMin,
    age_max: ageMax,
    day_of_week: dayOfWeek,
    start_time: startTime,
    display_time: displayTime,
    recurrence: "weekly",
    note: description || "Pulled from LibCal — confirm registration requirements on the source page.",
    source_url: raw.url || raw.public_url || "",
    verified: 1,
    libcal_event_id: String(raw.id),
  };
}


// --- ical.js ---
/**
 * Parses LibCal's public iCal subscribe feed (ical_subscribe.php) — a
 * static, unauthenticated .ics file. No API key, no headless browser,
 * just a plain fetch(). Confirmed working against Erie's real feed:
 * https://highplains.libcal.com/ical_subscribe.php?src=p&cid=8181&cam=4556
 *
 * This is a better automation path than either the OAuth API (declined)
 * or the Playwright scraper (needs a real browser) — it can run natively
 * inside the Worker's cron trigger, no separate infrastructure at all.
 */

/** RFC 5545 line unfolding: continuation lines start with a space/tab. */
function unfoldICal(text) {
  return text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
}

function unescapeICalText(s) {
  if (!s) return s;
  return s
    .replace(/\\n/g, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

/** Parses "20260601T153000Z" into a UTC Date. */
function parseICalDate(raw) {
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
}

/** Splits a "KEY;PARAM=X:value" line into { key, value }, params ignored. */
function parseICalLine(line) {
  const colonIdx = line.indexOf(":");
  if (colonIdx === -1) return null;
  const keyPart = line.slice(0, colonIdx);
  const value = line.slice(colonIdx + 1);
  const key = keyPart.split(";")[0].trim().toUpperCase();
  return { key, value };
}

/**
 * Parses the full .ics text into an array of raw event objects. Ignores
 * anything outside BEGIN:VEVENT/END:VEVENT blocks (calendar metadata).
 */
function parseICalFeed(icsText) {
  const unfolded = unfoldICal(icsText);
  const lines = unfolded.split("\n").map((l) => l.trim()).filter(Boolean);

  const events = [];
  let current = null;

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      current = {};
      continue;
    }
    if (line === "END:VEVENT") {
      if (current) events.push(current);
      current = null;
      continue;
    }
    if (!current) continue;

    const parsed = parseICalLine(line);
    if (!parsed) continue;
    const { key, value } = parsed;

    if (key === "DTSTART") current.dtstart = parseICalDate(value);
    else if (key === "DTEND") current.dtend = parseICalDate(value);
    else if (key === "SUMMARY") current.summary = unescapeICalText(value);
    else if (key === "DESCRIPTION") current.description = unescapeICalText(value);
    else if (key === "LOCATION") current.location = unescapeICalText(value);
    else if (key === "CATEGORIES") current.categories = unescapeICalText(value);
    else if (key === "UID") current.uid = value;
    else if (key === "URL") current.url = value;
  }

  return events;
}

/**
 * Filters to events actually relevant to young kids (0-8). Precision
 * over recall here deliberately — the LibCal CATEGORIES field reliably
 * tags "Storytime" for the core programs we already trust (Twinkle
 * Babies, Family Storytime, Tales for Tots, Music & Movement, Adaptive
 * Storytime, Baby Open Play, Saturday Family Storytime), plus a couple
 * explicit title matches for known-good non-Storytime-tagged programs
 * we already have in the database (Family LEGO Club). Broader kid STEM/
 * craft programs (Dino-Mite Dioramas, Junior Geologists, etc.) are
 * intentionally NOT auto-included yet — better to miss some real
 * programs than accidentally import teen D&D nights or adult book clubs
 * because a keyword heuristic guessed wrong.
 */
function isKidRelevant(ev) {
  const categories = (ev.categories || "").toLowerCase();
  const summary = (ev.summary || "").toLowerCase();

  if (categories.includes("storytime")) return true;
  if (summary.includes("family lego club")) return true;
  if (summary.includes("baby open play")) return true;

  return false;
}

function to24Hour(date) {
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function formatDisplayTime(start, end) {
  const fmt = (d) =>
    d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
  return end ? `${fmt(start)} – ${fmt(end)}` : fmt(start);
}

/** Same age-inference approach already validated in the Boulder scraper. */
function ageFromText(description) {
  const d = (description || "").toLowerCase();

  let m = d.match(/up to (\d+) months?/);
  if (m) return { age_min: 0, age_max: +m[1] / 12 };

  m = d.match(/birth\s*[-–]\s*(\d+)\s*months?/);
  if (m) return { age_min: 0, age_max: +m[1] / 12 };

  m = d.match(/(\d+)\s*months?\s*to\s*(\d+)\s*years?/);
  if (m) return { age_min: +m[1] / 12, age_max: +m[2] };

  m = d.match(/(\d+)\s*[-–]\s*(\d+)\s*months?/);
  if (m) return { age_min: +m[1] / 12, age_max: +m[2] / 12 };

  m = d.match(/ages?\s*(\d+)\s*[-–]\s*(\d+)/);
  if (m) return { age_min: +m[1], age_max: +m[2] };

  return { age_min: 0, age_max: 5 }; // fallback: these are all Storytime-tagged, so "birth to 5" is a safe default
}

/**
 * Normalizes a raw parsed iCal event into the playroute schema. Uses the
 * iCal UID as libcal_event_id for dedup — re-running this won't create
 * duplicates, it'll just update existing rows (same ON CONFLICT pattern
 * as the OAuth-API scraper would have used).
 */
function normalizeICalEvent(ev, city) {
  if (!ev.summary || !ev.dtstart) return null;

  const { age_min, age_max } = ageFromText(ev.description);

  return {
    title: ev.summary,
    source: `${city} Public Library${ev.location ? " — " + ev.location : ""}`,
    city,
    category: "library",
    cost: "free",
    age_min,
    age_max,
    day_of_week: DAY_NAMES[ev.dtstart.getUTCDay()],
    start_time: to24Hour(ev.dtstart),
    display_time: formatDisplayTime(ev.dtstart, ev.dtend),
    recurrence: "dated",
    event_date: ev.dtstart.toISOString().slice(0, 10),
    note: (ev.description || "").replace(/<[^>]+>/g, "").slice(0, 300) || `Pulled from ${city} library's public iCal feed.`,
    source_url: ev.url || "",
    verified: 1,
    libcal_event_id: ev.uid,
  };
}

/**
 * Fetches and fully processes one library's iCal feed into
 * ready-to-ingest normalized events, filtered to kid-relevant programs
 * within a forward window (avoids importing months of data past what's
 * useful to show).
 *
 * trustSourceFilter: set true when the feed URL itself is already scoped
 * to the right age group by the library's own system (e.g. Boulder's
 * ?aud=6405 parameter, confirmed to return exactly the birth-5 programs
 * from the validated PDF export, plus events like "Toddler Explorers"
 * that our own Storytime-category check would incorrectly exclude since
 * they're tagged "Make & Create" instead). When true, skips isKidRelevant
 * and just filters out cancelled events. Erie's feed has no equivalent
 * source-side filter, so it needs isKidRelevant to do the real work.
 */
async function fetchAndNormalizeICalFeed(icalUrl, city, { daysAhead = 60, trustSourceFilter = false } = {}) {
  const res = await fetch(icalUrl);
  if (!res.ok) throw new Error(`iCal fetch failed for ${city}: ${res.status}`);

  const icsText = await res.text();
  const rawEvents = parseICalFeed(icsText);

  const now = new Date();
  const cutoff = new Date(now.getTime() + daysAhead * 86400000);

  return rawEvents
    .filter((ev) => trustSourceFilter || isKidRelevant(ev))
    .filter((ev) => !/^CANCEL/i.test(ev.summary || ""))
    .filter((ev) => ev.dtstart && ev.dtstart >= now && ev.dtstart <= cutoff)
    .map((ev) => normalizeICalEvent(ev, city))
    .filter(Boolean);
}


// --- index.js ---

/**
 * One entry per library system. Add Longmont/Lyons/Broomfield here once
 * their adapters exist — those aren't LibCal, so they'll need their own
 * scraper functions, not this one.
 *
 * calId values are the real LibCal calendar IDs found in each library's
 * public calendar URL (e.g. ?cid=8181). Confirm these still match before
 * relying on them — Springshare can renumber calendars.
 */
const LIBCAL_LIBRARIES = [
  { key: "boulder", city: "Boulder", base: "https://calendar.boulderlibrary.org", calId: "12892" },
  { key: "erie", city: "Erie", base: "https://highplains.libcal.com", calId: "8181" },
];

/**
 * Public iCal subscribe feeds — no API key, no headless browser, just a
 * plain fetch(). This is now the PRIMARY automation path (LibCal declined
 * API access for both libraries; this needs nothing from them at all).
 * Erie's URL is confirmed real and working. Boulder's calendar has the
 * same "Add to a Calendar using iCal" feature, but the actual subscribe
 * URL is generated by JavaScript on click, not visible in the static
 * page — add it here once someone grabs it from the site directly.
 */
const ICAL_LIBRARIES = [
  {
    city: "Boulder",
    url: "https://calendar.boulderlibrary.org/ical_subscribe.php?src=p&cid=12892&aud=6405",
    // Confirmed this exact URL returns exactly the birth-5 programs
    // validated against the real PDF export, plus a few "Make & Create"
    // tagged events (Toddler Explorers, etc.) our own Storytime-category
    // filter would wrongly exclude — trust Boulder's own audience filter
    // instead of re-filtering.
    trustSourceFilter: true,
  },
  {
    city: "Erie",
    url: "https://highplains.libcal.com/ical_subscribe.php?src=p&cid=8181&cam=4556",
    // No source-side age filter confirmed for Erie — this pulls
    // everything, so isKidRelevant needs to do the real filtering work.
    trustSourceFilter: false,
  },
];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return Response.json(data, { status, headers: CORS_HEADERS });
}

function errorResponse(err, status = 500) {
  console.error(err);
  return json({ error: String(err && err.message ? err.message : err) }, status);
}

async function upsertEvent(env, ev) {
  await env.DB.prepare(
    `INSERT INTO events
      (title, source, city, category, cost, age_min, age_max, day_of_week,
       start_time, display_time, recurrence, event_date, note, source_url,
       verified, libcal_event_id, season_start, season_end, last_scraped_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(libcal_event_id) DO UPDATE SET
       title=excluded.title,
       source=excluded.source,
       city=excluded.city,
       cost=excluded.cost,
       age_min=excluded.age_min,
       age_max=excluded.age_max,
       day_of_week=excluded.day_of_week,
       start_time=excluded.start_time,
       display_time=excluded.display_time,
       event_date=excluded.event_date,
       note=excluded.note,
       source_url=excluded.source_url,
       verified=excluded.verified,
       season_start=excluded.season_start,
       season_end=excluded.season_end,
       last_scraped_at=CURRENT_TIMESTAMP`
  )
    .bind(
      ev.title, ev.source, ev.city, ev.category, ev.cost, ev.age_min, ev.age_max,
      ev.day_of_week ?? null, ev.start_time, ev.display_time, ev.recurrence,
      ev.event_date ?? null, ev.note, ev.source_url, ev.verified, ev.libcal_event_id,
      ev.season_start ?? null, ev.season_end ?? null
    )
    .run();
}

async function runScrape(env) {
  const results = [];

  for (const lib of LIBCAL_LIBRARIES) {
    const clientId = env[`LIBCAL_${lib.key.toUpperCase()}_CLIENT_ID`];
    const clientSecret = env[`LIBCAL_${lib.key.toUpperCase()}_CLIENT_SECRET`];

    if (!clientId || !clientSecret) {
      results.push({ library: lib.key, status: "skipped", reason: "missing API credentials — see README" });
      continue;
    }

    try {
      const token = await getAccessToken(env, lib.base, clientId, clientSecret, `token:${lib.key}`);
      const rawEvents = await fetchLibCalEvents(lib.base, token, lib.calId, 14);

      let count = 0;
      for (const raw of rawEvents) {
        const ev = normalizeEvent(raw, lib.city);
        await upsertEvent(env, ev);
        count++;
      }

      results.push({ library: lib.key, status: "ok", eventsUpserted: count });
    } catch (err) {
      results.push({ library: lib.key, status: "error", error: String(err) });
    }
  }

  return results;
}

/**
 * The new primary automation path — no credentials needed at all. Runs
 * alongside (not instead of) runScrape, since runScrape gracefully
 * no-ops for libraries without API credentials anyway.
 */
async function runICalScrape(env) {
  const results = [];

  for (const lib of ICAL_LIBRARIES) {
    try {
      const events = await fetchAndNormalizeICalFeed(lib.url, lib.city, { trustSourceFilter: lib.trustSourceFilter });
      let count = 0;
      for (const ev of events) {
        await upsertEvent(env, ev);
        count++;
      }
      results.push({ library: lib.city, status: "ok", eventsUpserted: count });
    } catch (err) {
      results.push({ library: lib.city, status: "error", error: String(err) });
    }
  }

  return results;
}

/**
 * GET /api/events
 * Query params (all optional):
 *   city      — e.g. "Boulder" (exact match)
 *   category  — "library" | "rec" | "museum" | "outdoor"
 *   cost      — "free" (omit for "any")
 *   age       — "0-1.5" | "2-4" | "5-8" (matches the site's age buckets)
 *   includeIrregular — "1" to also include no-fixed-schedule events
 *                       (e.g. museum free days) at the end of the list
 *
 * Always excludes anything already in the past — dated one-off events
 * that have happened, or (for weekly/monthly recurrence) returns the
 * next upcoming instance rather than a stale reference to "today".
 */
async function handleEvents(env, url) {
  const city = url.searchParams.get("city");
  const category = url.searchParams.get("category");
  const cost = url.searchParams.get("cost");
  const ageBucket = url.searchParams.get("age");
  const includeIrregular = url.searchParams.get("includeIrregular") === "1";

  const conditions = [];
  const binds = [];
  if (city) { conditions.push("city = ?"); binds.push(city); }
  if (category) { conditions.push("category = ?"); binds.push(category); }
  if (cost) { conditions.push("cost = ?"); binds.push(cost); }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const { results } = await env.DB.prepare(`SELECT * FROM events ${where}`).bind(...binds).all();

  const now = new Date();
  const withOccurrence = [];
  const irregular = [];

  for (const ev of results) {
    if (!ageMatchesBucket(ev, ageBucket)) continue;

    if (ev.recurrence === "irregular") {
      if (includeIrregular) irregular.push({ ...ev, occurrence: null, occurrence_label: "Check dates — no fixed schedule" });
      continue;
    }

    const occ = getOccurrence(ev, now);
    if (!occ) continue; // one-off dated event already passed

    withOccurrence.push({
      ...ev,
      occurrence: occ.toISOString(),
      occurrence_label: formatOccurrenceLabel(occ),
    });
  }

  withOccurrence.sort((a, b) => new Date(a.occurrence) - new Date(b.occurrence));

  return json([...withOccurrence, ...irregular]);
}

async function handlePlaygrounds(env, url) {
  const city = url.searchParams.get("city");
  const sql = city ? "SELECT * FROM playgrounds WHERE city = ?" : "SELECT * FROM playgrounds";
  const { results } = await env.DB.prepare(sql).bind(...(city ? [city] : [])).all();
  return json(results);
}

async function handleHikes(env, url) {
  const city = url.searchParams.get("city");
  const sql = city ? "SELECT * FROM hikes WHERE city = ?" : "SELECT * FROM hikes";
  const { results } = await env.DB.prepare(sql).bind(...(city ? [city] : [])).all();
  return json(results);
}

async function handleSources(env) {
  const { results } = await env.DB.prepare("SELECT * FROM scrape_sources").all();
  return json(results);
}

/**
 * POST /api/track-click
 * Body: { event_id?, event_title, city?, category?, source_url }
 *
 * Minimal, anonymous click logging — just enough to see which listings
 * people actually follow through on. No cookies, no IP logging beyond
 * whatever Cloudflare does at the edge by default (which this code never
 * touches), no user identifiers of any kind. Intentionally open (no auth)
 * since it's a low-stakes counter, not a place sensitive data lives —
 * worth revisiting if it ever gets spammed.
 */
async function handleTrackClick(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.source_url || !body.event_title) {
    return json({ error: "event_title and source_url are required" }, 400);
  }

  await env.DB.prepare(
    `INSERT INTO link_clicks (event_id, event_title, city, category, source_url)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(body.event_id ?? null, body.event_title, body.city ?? null, body.category ?? null, body.source_url)
    .run();

  return json({ ok: true });
}

/**
 * POST /api/ingest
 * Authorization: Bearer <INGEST_SECRET>
 * Body: { events: [ { title, source, city, category, cost, age_min, age_max,
 *                      day_of_week?, start_time, display_time, recurrence,
 *                      event_date?, note, source_url, libcal_event_id? } ] }
 *
 * Generic write path for anything that isn't a built-in LibCal adapter —
 * the Boulder Playwright scraper, manual curation batches (like the
 * Longmont/Raising Parents ones done by hand), future adapters for
 * Louisville/Eventbrite/etc. All go through the same upsert logic as the
 * LibCal scraper, so there's exactly one place events get written.
 *
 * Requires INGEST_SECRET to be set via `wrangler secret put INGEST_SECRET`
 * — without it this endpoint refuses all requests, it does not silently
 * allow unauthenticated writes.
 */
async function handleIngest(request, env) {
  if (!env.INGEST_SECRET) {
    return json({ error: "INGEST_SECRET not configured on this Worker — see README" }, 500);
  }

  const auth = request.headers.get("Authorization") || "";
  if (auth !== `Bearer ${env.INGEST_SECRET}`) {
    return json({ error: "Unauthorized" }, 401);
  }

  const body = await request.json();
  const events = Array.isArray(body.events) ? body.events : [];
  if (events.length === 0) {
    return json({ error: "No events provided — expected { events: [...] }" }, 400);
  }

  const required = ["title", "source", "city", "category", "cost", "age_min", "age_max", "start_time", "recurrence", "note", "source_url"];
  let upserted = 0;
  const errors = [];

  for (const ev of events) {
    const missing = required.filter((k) => ev[k] === undefined || ev[k] === null);
    if (missing.length) {
      errors.push({ title: ev.title || "(untitled)", error: `Missing fields: ${missing.join(", ")}` });
      continue;
    }
    try {
      // Ingested events without a libcal_event_id still need a stable
      // dedup key so re-running the scraper doesn't create duplicates —
      // fall back to a hash of source_url + event_date/day_of_week.
      const dedupKey = ev.libcal_event_id || `ingest:${ev.source_url}:${ev.event_date || ev.day_of_week}`;
      await upsertEvent(env, { ...ev, libcal_event_id: dedupKey, verified: ev.verified ?? 1 });
      upserted++;
    } catch (err) {
      errors.push({ title: ev.title, error: String(err) });
    }
  }

  return json({ upserted, errors });
}

export default {
  // Cron Trigger entry point — configured in wrangler.jsonc
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScrape(env)); // OAuth API path — no-ops gracefully without credentials
    ctx.waitUntil(runICalScrape(env)); // iCal path — the one that actually runs right now
  },

  // HTTP entry point — this is what the frontend fetches from instead of
  // using a hardcoded JS array.
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    try {
      if (url.pathname === "/api/events") return await handleEvents(env, url);
      if (url.pathname === "/api/playgrounds") return await handlePlaygrounds(env, url);
      if (url.pathname === "/api/hikes") return await handleHikes(env, url);
      if (url.pathname === "/api/sources") return await handleSources(env);
      if (url.pathname === "/api/track-click" && request.method === "POST") return await handleTrackClick(request, env);

      // Manual trigger for testing the scrapers without waiting for the cron.
      if (url.pathname === "/api/scrape-now" && request.method === "POST") {
        const [apiResults, icalResults] = await Promise.all([runScrape(env), runICalScrape(env)]);
        return json({ ranAt: new Date().toISOString(), apiResults, icalResults });
      }

      if (url.pathname === "/api/ingest" && request.method === "POST") {
        return await handleIngest(request, env);
      }
    } catch (err) {
      return errorResponse(err);
    }

    return new Response(
      "Playroute API — try /api/events, /api/playgrounds, /api/hikes, /api/sources, or POST /api/scrape-now\n\n" +
        "/api/events supports ?city=&category=&cost=free&age=0-1.5|2-4|5-8&includeIrregular=1",
      { headers: CORS_HEADERS }
    );
  },
};
