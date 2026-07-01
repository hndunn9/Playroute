// ===== playroute-worker: single-file bundle for Cloudflare dashboard's Quick Edit / Git deploy =====
// Generated from occurrence.js + libcal.js + index.js — same code, no wrangler/CLI needed.

// --- occurrence.js ---
/**
 * Computes each event's next real occurrence so the API can filter out
 * anything already passed and sort everything chronologically, instead of
 * handing the frontend raw day-of-week strings to figure out itself.
 *
 * Mirrors the logic originally built into the static Phase 0 site — kept
 * here so the API and any future client agree on what "upcoming" means.
 */

const DAY_INDEX = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };

function lastSundayOfMonth(year, month) {
  const d = new Date(Date.UTC(year, month + 1, 0));
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d;
}

function getNextMonthlyLastSunday(startTime, now) {
  const [hh, mm] = startTime.split(":").map(Number);
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth();
  let candidate = lastSundayOfMonth(year, month);
  candidate.setUTCHours(hh, mm, 0, 0);
  if (candidate < now) {
    month++;
    if (month > 11) {
      month = 0;
      year++;
    }
    candidate = lastSundayOfMonth(year, month);
    candidate.setUTCHours(hh, mm, 0, 0);
  }
  return candidate;
}

function getNextWeeklyOccurrence(dayName, startTime, now) {
  const [hh, mm] = startTime.split(":").map(Number);
  const targetIdx = DAY_INDEX[dayName];
  if (targetIdx === undefined) return null;

  let diff = (targetIdx - now.getUTCDay() + 7) % 7;
  const candidate = new Date(now);
  candidate.setUTCDate(now.getUTCDate() + diff);
  candidate.setUTCHours(hh, mm, 0, 0);

  if (diff === 0 && candidate < now) {
    candidate.setUTCDate(candidate.getUTCDate() + 7);
  }
  return candidate;
}

function getDatedOccurrence(eventDate, startTime) {
  if (!eventDate) return null;
  const [hh, mm] = (startTime || "00:00").split(":").map(Number);
  const d = new Date(`${eventDate}T00:00:00Z`);
  if (isNaN(d.getTime())) return null;
  d.setUTCHours(hh, mm, 0, 0);
  return d;
}

/**
 * Returns a Date for the event's next occurrence, or null if it's a
 * one-off dated event that has already passed (and therefore shouldn't
 * be shown), or if recurrence is "irregular" (no computable schedule —
 * e.g. a sponsor-funded museum free day with no fixed cadence).
 */
function getOccurrence(ev, now = new Date()) {
  if (ev.recurrence === "dated") {
    const occ = getDatedOccurrence(ev.event_date, ev.start_time);
    if (!occ || occ < now) return null; // one-off, already happened
    return occ;
  }
  if (ev.recurrence === "monthly-last-sunday") {
    return getNextMonthlyLastSunday(ev.start_time, now);
  }
  if (ev.recurrence === "irregular") {
    return null; // no fixed schedule — caller decides how to surface these
  }
  // default: weekly
  return getNextWeeklyOccurrence(ev.day_of_week, ev.start_time, now);
}

function formatOccurrenceLabel(date) {
  if (!date) return null;
  const weekday = date.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  const md = date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `${weekday} · ${md}`;
}

/**
 * Age-bucket overlap check, matching the site's filter buckets:
 * "0-1.5" (0–18mo), "2-4", "5-8".
 */
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
       verified, libcal_event_id, last_scraped_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
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
       last_scraped_at=CURRENT_TIMESTAMP`
  )
    .bind(
      ev.title, ev.source, ev.city, ev.category, ev.cost, ev.age_min, ev.age_max,
      ev.day_of_week ?? null, ev.start_time, ev.display_time, ev.recurrence,
      ev.event_date ?? null, ev.note, ev.source_url, ev.verified, ev.libcal_event_id
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
    ctx.waitUntil(runScrape(env));
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

      // Manual trigger for testing the scraper without waiting for the cron.
      if (url.pathname === "/api/scrape-now" && request.method === "POST") {
        const results = await runScrape(env);
        return json({ ranAt: new Date().toISOString(), results });
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

  
