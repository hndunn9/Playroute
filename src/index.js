const DAY_INDEX = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
const TZ = "America/Denver";

function toMountainDate(dateStr, hh, mm) {
  try {
    const ref = new Date(`${dateStr}T12:00:00Z`);
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).formatToParts(ref);
    const p = Object.fromEntries(parts.filter((x) => x.type !== "literal").map((x) => [x.type, +x.value]));
    const utcOffsetMs = ref.getTime() - Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
    return new Date(
      Date.UTC(+dateStr.slice(0, 4), +dateStr.slice(5, 7) - 1, +dateStr.slice(8, 10), hh, mm, 0) + utcOffsetMs
    );
  } catch {
    return new Date(Date.UTC(
      +dateStr.slice(0, 4),
      +dateStr.slice(5, 7) - 1,
      +dateStr.slice(8, 10),
      hh + 6,
      mm,
      0
    ));
  }
}

function toMountainDateStr(date) {
  return date.toLocaleDateString("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).replace(/(\d+)\/(\d+)\/(\d+)/, "$3-$1-$2");
}

function lastSundayOfMonth(year, month) {
  const d = new Date(Date.UTC(year, month + 1, 0));
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d;
}

function getNextMonthlyLastSunday(startTime, now) {
  const [hh, mm] = startTime.split(":").map(Number);
  const nowMT = new Date(now.toLocaleString("en-US", { timeZone: TZ }));
  let year = nowMT.getFullYear(), month = nowMT.getMonth();
  let sunday = lastSundayOfMonth(year, month);
  let candidate = toMountainDate(sunday.toISOString().slice(0, 10), hh, mm);
  if (candidate < now) {
    month++;
    if (month > 11) {
      month = 0;
      year++;
    }
    sunday = lastSundayOfMonth(year, month);
    candidate = toMountainDate(sunday.toISOString().slice(0, 10), hh, mm);
  }
  return candidate;
}

function getNextWeeklyOccurrence(dayName, startTime, now) {
  const [hh, mm] = startTime.split(":").map(Number);
  const targetIdx = DAY_INDEX[dayName];
  if (targetIdx === undefined) return null;
  const nowDowMT = new Date(now.toLocaleString("en-US", { timeZone: TZ })).getDay();
  let diff = (targetIdx - nowDowMT + 7) % 7;
  const todayMT = toMountainDateStr(now);
  const todayMs = new Date(todayMT + "T12:00:00Z").getTime();
  const candidateDateStr = new Date(todayMs + diff * 864e5).toISOString().slice(0, 10);
  let candidate = toMountainDate(candidateDateStr, hh, mm);
  if (diff === 0 && candidate < now) {
    const nextDateStr = new Date(todayMs + 7 * 864e5).toISOString().slice(0, 10);
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
  return `${weekday} \u00B7 ${md}`;
}

function ageMatchesBucket(ev, bucketId) {
  if (!bucketId || bucketId === "all") return true;
  const [lo, hi] = bucketId.split("-").map(Number);
  return ev.age_max >= lo && ev.age_min <= hi;
}

async function getAccessToken(env, base, clientId, clientSecret, cacheKey) {
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
      client_secret: clientSecret
    })
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
  return Array.isArray(data) ? data : data.events || [];
}

function normalizeEvent(raw, cityName, timeZone = "America/Denver") {
  const start = new Date(raw.start);
  const dayOfWeek = start.toLocaleDateString("en-US", { weekday: "long", timeZone });
  const startTime = start.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone
  });
  const displayStart = start.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone
  });
  let displayTime = displayStart;
  if (raw.end) {
    const end = new Date(raw.end);
    const displayEnd = end.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone
    });
    displayTime = `${displayStart} \u2013 ${displayEnd}`;
  }
  const audience = (raw.audience || []).map((a) => typeof a === "string" ? a : a.name || "").join(",").toLowerCase();
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
    note: description || "Pulled from LibCal \u2014 confirm registration requirements on the source page.",
    source_url: raw.url || raw.public_url || "",
    verified: 1,
    libcal_event_id: String(raw.id)
  };
}

function unfoldICal(text) {
  return text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
}

function unescapeICalText(s) {
  if (!s) return s;
  return s.replace(/\\n/g, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

function parseICalDate(raw) {
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
}

function parseICalLine(line) {
  const colonIdx = line.indexOf(":");
  if (colonIdx === -1) return null;
  const keyPart = line.slice(0, colonIdx);
  const value = line.slice(colonIdx + 1);
  const key = keyPart.split(";")[0].trim().toUpperCase();
  return { key, value };
}

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
  const fmt = (d) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
  return end ? `${fmt(start)} \u2013 ${fmt(end)}` : fmt(start);
}

function ageFromText(description) {
  const d = (description || "").toLowerCase();
  let m = d.match(/up to (\d+) months?/);
  if (m) return { age_min: 0, age_max: +m[1] / 12 };
  m = d.match(/birth\s*[-\u2013]\s*(\d+)\s*months?/);
  if (m) return { age_min: 0, age_max: +m[1] / 12 };
  m = d.match(/(\d+)\s*months?\s*to\s*(\d+)\s*years?/);
  if (m) return { age_min: +m[1] / 12, age_max: +m[2] };
  m = d.match(/(\d+)\s*[-\u2013]\s*(\d+)\s*months?/);
  if (m) return { age_min: +m[1] / 12, age_max: +m[2] / 12 };
  m = d.match(/ages?\s*(\d+)\s*[-\u2013]\s*(\d+)/);
  if (m) return { age_min: +m[1], age_max: +m[2] };
  return { age_min: 0, age_max: 5 };
}

function normalizeICalEvent(ev, city) {
  if (!ev.summary || !ev.dtstart) return null;
  const { age_min, age_max } = ageFromText(ev.description);
  return {
    title: ev.summary,
    source: `${city} Public Library${ev.location ? " \u2014 " + ev.location : ""}`,
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
    libcal_event_id: ev.uid
  };
}

async function fetchAndNormalizeICalFeed(icalUrl, city, { daysAhead = 60, trustSourceFilter = false } = {}) {
  const res = await fetch(icalUrl);
  if (!res.ok) throw new Error(`iCal fetch failed for ${city}: ${res.status}`);
  const icsText = await res.text();
  const rawEvents = parseICalFeed(icsText);
  const now = new Date();
  const cutoff = new Date(now.getTime() + daysAhead * 864e5);
  return rawEvents
    .filter((ev) => trustSourceFilter || isKidRelevant(ev))
    .filter((ev) => !/^CANCEL/i.test(ev.summary || ""))
    .filter((ev) => ev.dtstart && ev.dtstart >= now && ev.dtstart <= cutoff)
    .map((ev) => normalizeICalEvent(ev, city))
    .filter(Boolean);
}

const LIBCAL_LIBRARIES = [
  { key: "boulder", city: "Boulder", base: "https://calendar.boulderlibrary.org", calId: "12892" },
  { key: "erie", city: "Erie", base: "https://highplains.libcal.com", calId: "8181" }
];

const ICAL_LIBRARIES = [
  {
    city: "Boulder",
    url: "https://calendar.boulderlibrary.org/ical_subscribe.php?src=p&cid=12892&aud=6405",
    // Confirmed this exact URL returns exactly the birth-5 programs
    // validated against the real PDF export, plus a few "Make & Create"
    // tagged events (Toddler Explorers, etc.) our own Storytime-category
    // filter would wrongly exclude — trust Boulder's own audience filter
    // instead of re-filtering.
    trustSourceFilter: true
  },
  {
    city: "Erie",
    url: "https://highplains.libcal.com/ical_subscribe.php?src=p&cid=8181&cam=4556",
    // No source-side age filter confirmed for Erie — this pulls
    // everything, so isKidRelevant needs to do the real filtering work.
    trustSourceFilter: false
  }
];

// ---------------------------------------------------------------------
// HTML calendar scraping — for sources with no iCal/JSON feed.
// Currently: WOW! Children's Museum (Firespring CMS calendar).
// ---------------------------------------------------------------------

function decodeHtmlEntities(s) {
  if (!s) return s;
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripTags(s) {
  return (s || "").replace(/<[^>]+>/g, "");
}

// Rough age heuristic from WOW's known recurring program names — WOW's
// calendar page doesn't expose per-event age metadata, unlike LibCal's
// audience field, so this is inferred from the program title. Default
// range is broad since it's a general children's museum. Revisit if WOW
// adds new recurring programs not covered here.
function wowAgeFromTitle(title) {
  const t = (title || "").toLowerCase();
  if (t.includes("littlest learners")) return { age_min: 0, age_max: 2 };
  if (t.includes("storytime")) return { age_min: 0, age_max: 5 };
  if (t.includes("kindergarten")) return { age_min: 4, age_max: 6 };
  if (t.includes("steam to the max")) return { age_min: 5, age_max: 10 };
  if (t.includes("science spot")) return { age_min: 4, age_max: 9 };
  if (t.includes("garden program")) return { age_min: 2, age_max: 8 };
  if (t.includes("teknologies") || t.includes("camp")) return { age_min: 6, age_max: 12 };
  return { age_min: 0, age_max: 10 };
}

// Parses one WOW calendar month page. WOW's Firespring template renders
// every event twice: once as a short link in the calendar grid, and again
// in a fuller day-by-day agenda list further down the page (used here for
// accessibility/SEO). Both link to the same event URL, ending in a stable
// numeric event ID — e.g. .../littlest-learners/419833 — which we use as
// the dedup key. The agenda-list copy appears later in the raw HTML and
// has richer text (full start–end time range, or "(Day X of Y) Starts/
// All Day/Until" for multi-day camps), so by scanning matches in document
// order and keying a Map by event ID, the agenda version naturally wins
// over the terser grid version for any event that appears in both.
const WOW_EVENT_LINK_RE = /<a\s+[^>]*href="([^"]*\/event\/(\d{4})\/(\d{2})\/(\d{2})\/[^"]*\/(\d+))"[^>]*>(.*?)<\/a>/gis;

function parseWowCalendarHtml(html, city) {
  const byId = new Map();
  let m;
  while ((m = WOW_EVENT_LINK_RE.exec(html)) !== null) {
    const [, href, year, month, day, id, innerHtml] = m;
    const text = decodeHtmlEntities(stripTags(innerHtml));
    if (!text) continue;
    byId.set(id, { href, year, month, day, id, text });
  }

  const events = [];
  for (const { href, year, month, day, id, text } of byId.values()) {
    let title = text;
    let startTime = null; // "HH:MM" 24h, or null if unknown (e.g. "All Day")
    let allDay = false;

    // Agenda style with explicit end time: "Title 9:30 am - 10:00 am"
    let mm = text.match(/^(.*?)\s+(\d{1,2}:\d{2}\s*[ap]m)\s*[-\u2013]\s*(\d{1,2}:\d{2}\s*[ap]m)\s*$/i);
    if (mm) {
      title = mm[1].trim();
      startTime = to24HourFromLabel(mm[2]);
    } else {
      // Multi-day camp style: "Title ($) (Day 2 of 5 ) All Day" / "... Starts 9:00 am" / "... Until 12:00 pm"
      mm = text.match(/^(.*?)\s*\(Day \d+ of \d+\s*\)\s*(Starts|Until|All Day)\s*(\d{1,2}:\d{2}\s*[ap]m)?\s*$/i);
      if (mm) {
        title = mm[1].trim();
        if (mm[2].toLowerCase() === "all day") {
          allDay = true;
        } else if (mm[3]) {
          startTime = to24HourFromLabel(mm[3]);
        }
      } else {
        // Grid style, no end time: "9:30 am Title"
        mm = text.match(/^(\d{1,2}:\d{2}\s*[ap]m)\s+(.*)$/i);
        if (mm) {
          startTime = to24HourFromLabel(mm[1]);
          title = mm[2].trim();
        }
      }
    }

    const isPaid = /\(\$\)\s*$/.test(title);
    title = title.replace(/\(\$\)\s*$/, "").trim();
    if (!title) continue;

    const { age_min, age_max } = wowAgeFromTitle(title);
    const eventDate = `${year}-${month}-${day}`;
    const finalStartTime = startTime || "09:00"; // fallback to museum open time
    const displayTime = allDay
      ? "All day \u2014 see source for schedule"
      : startTime
      ? new Date(`2000-01-01T${finalStartTime}:00`).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
      : "See source for time";

    events.push({
      title,
      source: `${city} \u2014 WOW! Children's Museum`,
      city,
      category: "museum",
      cost: isPaid ? "paid" : "free",
      age_min,
      age_max,
      day_of_week: undefined,
      start_time: finalStartTime,
      display_time: displayTime,
      recurrence: "dated",
      event_date: eventDate,
      note: allDay
        ? "Multi-day program \u2014 check the museum's event page for the full daily schedule."
        : "Pulled from WOW! Children's Museum's public calendar.",
      source_url: href.startsWith("http") ? href : `https://wowchildrensmuseum.org${href}`,
      verified: 1,
      libcal_event_id: `wow:${id}`
    });
  }
  return events;
}

function to24HourFromLabel(label) {
  const m = label.match(/(\d{1,2}):(\d{2})\s*([ap])m/i);
  if (!m) return null;
  let [, h, min, ap] = m;
  h = +h;
  if (ap.toLowerCase() === "p" && h !== 12) h += 12;
  if (ap.toLowerCase() === "a" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${min}`;
}

// Returns the current-month calendar URL plus `monthsAhead` following
// months' URLs, following WOW's /calendar.html/calendar/{year}/{month} pattern.
function getWowMonthUrls(baseUrl, monthsAhead, now) {
  const nowMT = new Date(now.toLocaleString("en-US", { timeZone: TZ }));
  const urls = [baseUrl];
  let year = nowMT.getFullYear();
  let month = nowMT.getMonth() + 1; // 1-indexed
  for (let i = 0; i < monthsAhead; i++) {
    month++;
    if (month > 12) {
      month = 1;
      year++;
    }
    urls.push(`${baseUrl}/calendar/${year}/${month}`);
  }
  return urls;
}

const WOW_MUSEUM = {
  city: "Lafayette",
  baseUrl: "https://wowchildrensmuseum.org/news-events/calendar.html",
  monthsAhead: 2 // current month + next 2 (~90 days of coverage)
};

async function fetchAndNormalizeWowCalendar() {
  const now = new Date();
  const urls = getWowMonthUrls(WOW_MUSEUM.baseUrl, WOW_MUSEUM.monthsAhead, now);
  const cutoff = new Date(now.getTime() + 100 * 864e5);
  const allEvents = [];
  for (const url of urls) {
    const res = await fetch(url, { headers: { "User-Agent": "PlayrouteBot/1.0 (+https://playroute.app)" } });
    if (!res.ok) throw new Error(`WOW calendar fetch failed for ${url}: ${res.status}`);
    const html = await res.text();
    allEvents.push(...parseWowCalendarHtml(html, WOW_MUSEUM.city));
  }
  // De-dupe across month pages (boundary events can appear on two month
  // pages) and drop anything already in the past or past the lookahead window.
  const byId = new Map();
  for (const ev of allEvents) byId.set(ev.libcal_event_id, ev);
  return [...byId.values()].filter((ev) => {
    const d = new Date(`${ev.event_date}T${ev.start_time}:00-06:00`);
    return d >= now && d <= cutoff;
  });
}

async function runHtmlScrape(env) {
  const results = [];
  try {
    const events = await fetchAndNormalizeWowCalendar();
    let count = 0;
    for (const ev of events) {
      await upsertEvent(env, ev);
      count++;
    }
    results.push({ source: "WOW Children's Museum", status: "ok", eventsUpserted: count });
  } catch (err) {
    results.push({ source: "WOW Children's Museum", status: "error", error: String(err) });
  }
  return results;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
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
  ).bind(
    ev.title,
    ev.source,
    ev.city,
    ev.category,
    ev.cost,
    ev.age_min,
    ev.age_max,
    ev.day_of_week ?? null,
    ev.start_time,
    ev.display_time,
    ev.recurrence,
    ev.event_date ?? null,
    ev.note,
    ev.source_url,
    ev.verified,
    ev.libcal_event_id,
    ev.season_start ?? null,
    ev.season_end ?? null
  ).run();
}

async function runScrape(env) {
  const results = [];
  for (const lib of LIBCAL_LIBRARIES) {
    const clientId = env[`LIBCAL_${lib.key.toUpperCase()}_CLIENT_ID`];
    const clientSecret = env[`LIBCAL_${lib.key.toUpperCase()}_CLIENT_SECRET`];
    if (!clientId || !clientSecret) {
      results.push({ library: lib.key, status: "skipped", reason: "missing API credentials \u2014 see README" });
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

async function handleEvents(env, url) {
  const city = url.searchParams.get("city");
  const category = url.searchParams.get("category");
  const cost = url.searchParams.get("cost");
  const ageBucket = url.searchParams.get("age");
  const includeIrregular = url.searchParams.get("includeIrregular") === "1";
  const conditions = [];
  const binds = [];
  if (city) {
    conditions.push("city = ?");
    binds.push(city);
  }
  if (category) {
    conditions.push("category = ?");
    binds.push(category);
  }
  if (cost) {
    conditions.push("cost = ?");
    binds.push(cost);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const { results } = await env.DB.prepare(`SELECT * FROM events ${where}`).bind(...binds).all();
  const now = new Date();
  const withOccurrence = [];
  const irregular = [];
  for (const ev of results) {
    if (!ageMatchesBucket(ev, ageBucket)) continue;
    if (ev.recurrence === "irregular") {
      if (includeIrregular) irregular.push({ ...ev, occurrence: null, occurrence_label: "Check dates \u2014 no fixed schedule" });
      continue;
    }
    const occ = getOccurrence(ev, now);
    if (!occ) continue;
    withOccurrence.push({
      ...ev,
      occurrence: occ.toISOString(),
      occurrence_label: formatOccurrenceLabel(occ)
    });
  }
  withOccurrence.sort((a, b) => new Date(a.occurrence) - new Date(b.occurrence));
  return json([...withOccurrence, ...irregular]);
}

async function handlePlaygrounds(env, url) {
  const city = url.searchParams.get("city");
  const sql = city ? "SELECT * FROM playgrounds WHERE city = ?" : "SELECT * FROM playgrounds";
  const { results } = await env.DB.prepare(sql).bind(...city ? [city] : []).all();
  return json(results);
}

async function handleHikes(env, url) {
  const city = url.searchParams.get("city");
  const sql = city ? "SELECT * FROM hikes WHERE city = ?" : "SELECT * FROM hikes";
  const { results } = await env.DB.prepare(sql).bind(...city ? [city] : []).all();
  return json(results);
}

async function handleSources(env) {
  const { results } = await env.DB.prepare("SELECT * FROM scrape_sources").all();
  return json(results);
}

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
  ).bind(body.event_id ?? null, body.event_title, body.city ?? null, body.category ?? null, body.source_url).run();
  return json({ ok: true });
}

async function handleIngest(request, env) {
  if (!env.INGEST_SECRET) {
    return json({ error: "INGEST_SECRET not configured on this Worker \u2014 see README" }, 500);
  }
  const auth = request.headers.get("Authorization") || "";
  if (auth !== `Bearer ${env.INGEST_SECRET}`) {
    return json({ error: "Unauthorized" }, 401);
  }
  const body = await request.json();
  const events = Array.isArray(body.events) ? body.events : [];
  if (events.length === 0) {
    return json({ error: "No events provided \u2014 expected { events: [...] }" }, 400);
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
      const dedupKey = ev.libcal_event_id || `ingest:${ev.source_url}:${ev.event_date || ev.day_of_week}`;
      await upsertEvent(env, { ...ev, libcal_event_id: dedupKey, verified: ev.verified ?? 1 });
      upserted++;
    } catch (err) {
      errors.push({ title: ev.title, error: String(err) });
    }
  }
  return json({ upserted, errors });
}

// ---------------------------------------------------------------------
// WEEKLY DIGEST EMAIL — Sunday ~12pm Mountain, snapshot of the week ahead
// plus a link back to Playroute. Sent via Resend (https://resend.com);
// requires RESEND_API_KEY and DIGEST_FROM secrets (see README). MVP
// scope: text/HTML summary of top upcoming events, no screenshot —
// fastest path to something useful; a real screenshot via Cloudflare
// Browser Rendering is a reasonable fast-follow if this gets used.
// ---------------------------------------------------------------------

const DIGEST_SITE_URL = "https://test.playroute.workers.dev";
const DIGEST_MAX_PER_DAY = 6;
const DIGEST_MAX_DAYS = 7;

function escapeHtml(s) {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function getWeekAheadEvents(env) {
  const { results } = await env.DB.prepare("SELECT * FROM events").all();
  const now = new Date();
  const cutoff = new Date(now.getTime() + DIGEST_MAX_DAYS * 864e5);
  const withOccurrence = [];
  for (const ev of results) {
    if (ev.recurrence === "irregular") continue;
    const occ = getOccurrence(ev, now);
    if (!occ || occ > cutoff) continue;
    withOccurrence.push({ ...ev, occurrence: occ, occurrence_label: formatOccurrenceLabel(occ) });
  }
  withOccurrence.sort((a, b) => a.occurrence - b.occurrence);

  // Group by day, capping how many show per day so the email stays skimmable.
  const byDay = new Map();
  for (const ev of withOccurrence) {
    const list = byDay.get(ev.occurrence_label) || [];
    if (list.length < DIGEST_MAX_PER_DAY) list.push(ev);
    byDay.set(ev.occurrence_label, list);
  }
  return byDay;
}

function buildDigestHtml(byDay, unsubscribeUrl) {
  const days = [...byDay.entries()];
  const dayBlocks = days.map(([label, evs]) => {
    const rows = evs.map((ev) => `
      <tr>
        <td style="padding:6px 0;font-family:sans-serif;font-size:14px;color:#2c1f14;">
          <strong>${escapeHtml(ev.title)}</strong> \u2014 ${escapeHtml(ev.display_time)}
          <span style="color:#8a7a63;">\u00B7 ${escapeHtml(ev.city)} \u00B7 ${ev.cost === "free" ? "Free" : "Paid"}</span>
        </td>
      </tr>`).join("");
    return `
      <tr><td style="padding:18px 0 4px;font-family:sans-serif;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#a68a5b;border-bottom:1px solid #eee;">${escapeHtml(label)}</td></tr>
      ${rows}`;
  }).join("");

  const bodyContent = days.length
    ? `<table width="100%" cellpadding="0" cellspacing="0">${dayBlocks}</table>`
    : `<p style="font-family:sans-serif;color:#8a7a63;">No events loaded for this week yet \u2014 check the app directly.</p>`;

  return `
  <div style="max-width:520px;margin:0 auto;font-family:sans-serif;">
    <h1 style="font-family:serif;font-size:22px;color:#2c1f14;margin-bottom:4px;">This week on Playroute</h1>
    <p style="color:#8a7a63;font-size:13px;margin-top:0;">A quick look at what's coming up for the kids this week.</p>
    ${bodyContent}
    <div style="margin:28px 0;">
      <a href="${DIGEST_SITE_URL}" style="display:inline-block;background:#2c1f14;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:14px;">Open Playroute \u2192</a>
    </div>
    <p style="font-size:11px;color:#b5a88f;">You're getting this because you subscribed to Playroute's weekly digest. <a href="${unsubscribeUrl}" style="color:#b5a88f;">Unsubscribe</a></p>
  </div>`;
}

function buildDigestText(byDay) {
  const lines = ["This week on Playroute", ""];
  for (const [label, evs] of byDay.entries()) {
    lines.push(label.toUpperCase());
    for (const ev of evs) {
      lines.push(`- ${ev.title} \u2014 ${ev.display_time} \u00B7 ${ev.city} \u00B7 ${ev.cost === "free" ? "Free" : "Paid"}`);
    }
    lines.push("");
  }
  lines.push(`Open Playroute: ${DIGEST_SITE_URL}`);
  return lines.join("\n");
}

async function sendDigestEmail(env, toEmail, html, text) {
  if (!env.RESEND_API_KEY || !env.DIGEST_FROM) {
    throw new Error("RESEND_API_KEY / DIGEST_FROM not configured \u2014 see README");
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: env.DIGEST_FROM,
      to: [toEmail],
      subject: "This week on Playroute \uD83C\uDF33",
      html,
      text
    })
  });
  if (!res.ok) {
    throw new Error(`Resend send failed for ${toEmail}: ${res.status} ${await res.text()}`);
  }
}

async function runWeeklyDigest(env) {
  const byDay = await getWeekAheadEvents(env);
  const { results: subs } = await env.DB.prepare(
    "SELECT email FROM subscribers WHERE active = 1"
  ).all();
  const results = [];
  for (const { email } of subs) {
    const unsubscribeUrl = `${DIGEST_SITE_URL}/api/unsubscribe?email=${encodeURIComponent(email)}`;
    const html = buildDigestHtml(byDay, unsubscribeUrl);
    const text = buildDigestText(byDay);
    try {
      await sendDigestEmail(env, email, html, text);
      results.push({ email, status: "sent" });
    } catch (err) {
      results.push({ email, status: "error", error: String(err) });
    }
  }
  return results;
}

// Cron triggers at both 18:00 and 19:00 UTC on Sundays (see wrangler.jsonc)
// so the digest self-corrects across the MST/MDT switch without needing a
// manual cron edit twice a year — whichever firing lands closest to noon
// Mountain time is the one that actually sends.
function isNearNoonMountain(now) {
  const hourMT = +now.toLocaleString("en-US", { timeZone: TZ, hour: "2-digit", hour12: false });
  return hourMT === 12;
}

async function handleSubscribe(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const email = (body.email || "").trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: "Valid email required" }, 400);
  }
  await env.DB.prepare(
    `INSERT INTO subscribers (email, active) VALUES (?, 1)
     ON CONFLICT(email) DO UPDATE SET active = 1, unsubscribed_at = NULL`
  ).bind(email).run();
  return json({ ok: true });
}

async function handleUnsubscribe(request, env, url) {
  const email = (url.searchParams.get("email") || "").trim().toLowerCase();
  if (!email) return json({ error: "email query param required" }, 400);
  await env.DB.prepare(
    `UPDATE subscribers SET active = 0, unsubscribed_at = CURRENT_TIMESTAMP WHERE email = ?`
  ).bind(email).run();
  return new Response("You're unsubscribed from the Playroute weekly digest. Sorry to see you go!", {
    headers: { "Content-Type": "text/plain", ...CORS_HEADERS }
  });
}

async function handlePhoto(env, key) {
  const obj = await env.PHOTOS.get(key);
  if (!obj) return new Response("Not found", { status: 404, headers: CORS_HEADERS });
  const headers = new Headers(CORS_HEADERS);
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("Cache-Control", "public, max-age=86400");
  return new Response(obj.body, { headers });
}

export default {
  // Cron Trigger entry point — configured in wrangler.jsonc
  async scheduled(event, env, ctx) {
    if (event.cron === "0 18 * * 0" || event.cron === "0 19 * * 0") {
      if (isNearNoonMountain(new Date())) {
        ctx.waitUntil(runWeeklyDigest(env));
      }
      return;
    }
    ctx.waitUntil(runScrape(env));
    ctx.waitUntil(runICalScrape(env));
    ctx.waitUntil(runHtmlScrape(env));
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
      if (url.pathname.startsWith("/api/photos/")) {
        return await handlePhoto(env, decodeURIComponent(url.pathname.slice("/api/photos/".length)));
      }
      if (url.pathname === "/api/track-click" && request.method === "POST") return await handleTrackClick(request, env);
      if (url.pathname === "/api/scrape-now" && request.method === "POST") {
        const [apiResults, icalResults, htmlResults] = await Promise.all([
          runScrape(env),
          runICalScrape(env),
          runHtmlScrape(env)
        ]);
        return json({ ranAt: new Date().toISOString(), apiResults, icalResults, htmlResults });
      }
      if (url.pathname === "/api/ingest" && request.method === "POST") {
        return await handleIngest(request, env);
      }
      if (url.pathname === "/api/subscribe" && request.method === "POST") {
        return await handleSubscribe(request, env);
      }
      if (url.pathname === "/api/unsubscribe") {
        return await handleUnsubscribe(request, env, url);
      }
      if (url.pathname === "/api/digest-now" && request.method === "POST") {
        const results = await runWeeklyDigest(env);
        return json({ ranAt: new Date().toISOString(), results });
      }
    } catch (err) {
      return errorResponse(err);
    }
    return new Response(
      "Playroute API \u2014 try /api/events, /api/playgrounds, /api/hikes, /api/sources, or POST /api/scrape-now\n\n/api/events supports ?city=&category=&cost=free&age=0-1.5|2-4|5-8&includeIrregular=1",
      { headers: CORS_HEADERS }
    );
  }
};
