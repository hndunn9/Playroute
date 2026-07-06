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

// Generalized version: the Nth occurrence of a given weekday in a month
// (ordinal: "first"|"second"|"third"|"fourth"|"last"). Returns null if that
// ordinal doesn't exist in this particular month (e.g. a "fifth Tuesday").
const ORDINAL_WEEK_INDEX = { first: 0, second: 1, third: 2, fourth: 3 };
function nthWeekdayOfMonth(year, month, weekdayIdx, ordinal) {
  if (ordinal === "last") {
    const d = new Date(Date.UTC(year, month + 1, 0));
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() - weekdayIdx + 7) % 7));
    return d;
  }
  const idx = ORDINAL_WEEK_INDEX[ordinal];
  if (idx === undefined) return null;
  const first = new Date(Date.UTC(year, month, 1));
  const firstMatchDay = 1 + ((weekdayIdx - first.getUTCDay() + 7) % 7);
  const targetDay = firstMatchDay + idx * 7;
  const result = new Date(Date.UTC(year, month, targetDay));
  return result.getUTCMonth() === month ? result : null;
}

function getNextMonthlyOrdinalWeekday(ordinal, weekdayIdx, startTime, now, durationMs = 0) {
  const [hh, mm] = startTime.split(":").map(Number);
  const nowMT = new Date(now.toLocaleString("en-US", { timeZone: TZ }));
  let year = nowMT.getFullYear(), month = nowMT.getMonth();
  let target = nthWeekdayOfMonth(year, month, weekdayIdx, ordinal);
  let candidate = target ? toMountainDate(target.toISOString().slice(0, 10), hh, mm) : null;
  if (!candidate || candidate.getTime() + durationMs < now.getTime()) {
    month++;
    if (month > 11) { month = 0; year++; }
    target = nthWeekdayOfMonth(year, month, weekdayIdx, ordinal);
    candidate = target ? toMountainDate(target.toISOString().slice(0, 10), hh, mm) : null;
  }
  return candidate;
}

function getNextMonthlyLastSunday(startTime, now, durationMs = 0) {
  const [hh, mm] = startTime.split(":").map(Number);
  const nowMT = new Date(now.toLocaleString("en-US", { timeZone: TZ }));
  let year = nowMT.getFullYear(), month = nowMT.getMonth();
  let sunday = lastSundayOfMonth(year, month);
  let candidate = toMountainDate(sunday.toISOString().slice(0, 10), hh, mm);
  if (candidate.getTime() + durationMs < now.getTime()) {
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

function getNextWeeklyOccurrence(dayName, startTime, now, durationMs = 0) {
  const [hh, mm] = startTime.split(":").map(Number);
  const targetIdx = DAY_INDEX[dayName];
  if (targetIdx === undefined) return null;
  const nowDowMT = new Date(now.toLocaleString("en-US", { timeZone: TZ })).getDay();
  let diff = (targetIdx - nowDowMT + 7) % 7;
  const todayMT = toMountainDateStr(now);
  const todayMs = new Date(todayMT + "T12:00:00Z").getTime();
  const candidateDateStr = new Date(todayMs + diff * 864e5).toISOString().slice(0, 10);
  let candidate = toMountainDate(candidateDateStr, hh, mm);
  // Only roll to next week once the event has actually ENDED (start + duration),
  // not merely once its start time has passed — an in-progress event should
  // keep showing until it's actually over.
  if (diff === 0 && candidate.getTime() + durationMs < now.getTime()) {
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
  const durationMs = (ev.duration_minutes || 60) * 60000;
  if (ev.recurrence === "dated") {
    occ = getDatedOccurrence(ev.event_date, ev.start_time);
    if (!occ) return null;
    if (occ.getTime() + durationMs < now.getTime()) return null; // fully ended, not just started
    if (occ && !isInSeason(ev.season_start, ev.season_end, occ)) return null;
    return occ;
  } else if (ev.recurrence === "irregular") {
    return null;
  }

  // Weekly / monthly-last-sunday / monthly-{ordinal}-{weekday}: the
  // *immediate* next occurrence might fall outside a season_start/season_end
  // window (e.g. a program that moves venues partway through summer and
  // doesn't resume until several weeks from now). Rather than giving up
  // after one check, walk forward (capped at 60 candidates) until we find
  // one that's actually in season.
  const monthlyOrdinalMatch = /^monthly-(first|second|third|fourth)-(\w+)$/i.exec(ev.recurrence);
  const isMonthlyLastSunday = ev.recurrence === "monthly-last-sunday";
  const isWeeklyStyle = !isMonthlyLastSunday && !monthlyOrdinalMatch;

  let ordinal, weekdayIdx;
  if (monthlyOrdinalMatch) {
    ordinal = monthlyOrdinalMatch[1].toLowerCase();
    const dayName = monthlyOrdinalMatch[2][0].toUpperCase() + monthlyOrdinalMatch[2].slice(1).toLowerCase();
    weekdayIdx = DAY_INDEX[dayName];
  }

  let cursor = now;
  for (let i = 0; i < 60; i++) {
    if (isMonthlyLastSunday) {
      occ = getNextMonthlyLastSunday(ev.start_time, cursor, durationMs);
    } else if (monthlyOrdinalMatch && weekdayIdx !== undefined) {
      occ = getNextMonthlyOrdinalWeekday(ordinal, weekdayIdx, ev.start_time, cursor, durationMs);
    } else {
      occ = getNextWeeklyOccurrence(ev.day_of_week, ev.start_time, cursor, durationMs);
    }
    if (!occ) return null;
    if (isInSeason(ev.season_start, ev.season_end, occ)) return occ;
    // Nudge past this occurrence's actual END (not just its start) so the
    // duration-aware helpers above correctly treat it as expired and roll
    // forward to the next cycle, rather than returning the same candidate
    // repeatedly until the iteration cap is exhausted.
    cursor = new Date(occ.getTime() + durationMs + 60000);
  }
  return null; // 60 candidates out and never in season — likely misconfigured data
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
  await logJobRun(env, "html-scrape", results.some((r) => r.status === "error") ? "error" : "ok", results);
  return results;
}

// ---------------------------------------------------------------------
// Longmont Public Library — WordPress "The Events Calendar" plugin.
// This environment can't confirm an iCal/JSON export is reachable, but the
// plugin's event permalinks reliably embed the date for dated instances:
//   https://longmontcolorado.gov/event/{slug}/{YYYY-MM-DD}/
// That means the two fields riskiest to get wrong — URL and date — don't
// depend on this site's exact CSS classes at all. Only the title (anchor
// text) and time (nearest time-range text found after the link, not tied
// to a specific selector) do, so minor markup/theme differences shouldn't
// break this outright the way a class-name-dependent parser would.
//
// Scope is deliberately narrow on purpose: only titles matching a known,
// already-verified recurring children's/family program name are auto-added
// (LONGMONT_TITLE_ALLOWLIST, built from manually confirming each of these
// programs' real posting history earlier). One-off named specials
// (concerts, visiting performers, etc.) still need a human to set
// age/cost/category correctly, so those are left for manual review rather
// than guessed at — same philosophy as the Mead scraper below.
// ---------------------------------------------------------------------

const LONGMONT_LIBRARY_CATEGORY_URL = "https://longmontcolorado.gov/events/category/library/";
const LONGMONT_MAX_PAGES = 6; // confirmed reachable (~5-6 weeks of real postings) during manual testing

const LONGMONT_TITLE_ALLOWLIST = [
  { match: /^baby storytime$/i, category: "library", age_min: 0, age_max: 2 },
  { match: /^baby stay\s*&?\s*play/i, category: "library", age_min: 0, age_max: 2 },
  { match: /^toddler storytime$/i, category: "library", age_min: 1.5, age_max: 3 },
  { match: /^toddler stay\s*&?\s*play/i, category: "library", age_min: 2, age_max: 3 },
  { match: /^bilingual storytime$/i, category: "library", age_min: 0, age_max: 5 },
  { match: /^all ages storytime/i, category: "library", age_min: 0, age_max: 8 },
  { match: /^all ages stay\s*&?\s*play/i, category: "library", age_min: 0, age_max: 4 },
  { match: /^craft storytime$/i, category: "library", age_min: 2, age_max: 6 },
  { match: /^yoga storytime$/i, category: "library", age_min: 2, age_max: 6 },
  { match: /^kids club$/i, category: "library", age_min: 6, age_max: 8 },
  { match: /^read to rover$/i, category: "library", age_min: 5, age_max: 12 },
  { match: /^first monday craft kits$/i, category: "library", age_min: 3, age_max: 8 },
  { match: /^mis pininos/i, category: "library", age_min: 0, age_max: 3 },
  { match: /^kids'?\s*creative movement class$/i, category: "library", age_min: 2, age_max: 8 },
  { match: /^dogs enjoy afternoon reading/i, category: "library", age_min: 5, age_max: 12 }
];

function longmontMatchTitle(title) {
  return LONGMONT_TITLE_ALLOWLIST.find((rule) => rule.match.test(title.trim()));
}

// Matches Tribe Events Calendar's dated-instance permalink pattern, which
// is stable across sites using this plugin regardless of theme/CSS.
const LONGMONT_EVENT_LINK_RE = /<a\s+[^>]*href=["'](https:\/\/longmontcolorado\.gov\/event\/([a-z0-9-]+)\/(\d{4}-\d{2}-\d{2})\/)["'][^>]*>(.*?)<\/a>/gis;

function parseLongmontLibraryHtml(html) {
  const events = [];
  let m;
  while ((m = LONGMONT_EVENT_LINK_RE.exec(html)) !== null) {
    const [fullMatch, href, slug, eventDate, innerHtml] = m;
    const title = decodeHtmlEntities(stripTags(innerHtml));
    if (!title) continue;
    const rule = longmontMatchTitle(title);
    if (!rule) continue; // not a recognized child/family program \u2014 skip rather than guess

    // Scan a window of raw HTML right after the title link for a
    // "H:MM am - H:MM pm" time range \u2014 proximity-based like the WOW
    // parser, not tied to an exact selector.
    const windowEnd = m.index + fullMatch.length + 500;
    const nearbyText = decodeHtmlEntities(stripTags(html.slice(m.index + fullMatch.length, windowEnd)));
    const timeMatch = nearbyText.match(/(\d{1,2}(?::\d{2})?\s*[ap]m)\s*-\s*(\d{1,2}(?::\d{2})?\s*[ap]m)/i);
    if (!timeMatch) continue; // can't confidently place a time \u2014 skip rather than guess

    const startTime = to24HourFromLabel(timeMatch[1]);
    if (!startTime) continue;
    const displayTime = `${timeMatch[1].toUpperCase().replace(/\s+/g, " ")} \u2013 ${timeMatch[2].toUpperCase().replace(/\s+/g, " ")}`;

    events.push({
      title,
      source: "Longmont Public Library",
      city: "Longmont",
      category: rule.category,
      cost: "free",
      age_min: rule.age_min,
      age_max: rule.age_max,
      day_of_week: undefined,
      start_time: startTime,
      display_time: displayTime,
      recurrence: "dated",
      event_date: eventDate,
      note: "Pulled from the Longmont Public Library events calendar.",
      source_url: href,
      verified: 1,
      libcal_event_id: `longmont:${slug}:${eventDate}`
    });
  }
  return events;
}

async function fetchAndNormalizeLongmontLibrary() {
  const allEvents = [];
  let url = LONGMONT_LIBRARY_CATEGORY_URL;
  for (let page = 1; page <= LONGMONT_MAX_PAGES && url; page++) {
    const res = await fetch(url, { headers: { "User-Agent": "PlayrouteBot/1.0 (+https://playroute.co)" } });
    if (!res.ok) throw new Error(`Longmont library calendar fetch failed for ${url}: ${res.status}`);
    const html = await res.text();
    allEvents.push(...parseLongmontLibraryHtml(html));
    url = page < LONGMONT_MAX_PAGES ? `${LONGMONT_LIBRARY_CATEGORY_URL}page/${page + 1}/` : null;
  }
  return allEvents;
}

async function runLongmontScrape(env) {
  const results = [];
  try {
    const events = await fetchAndNormalizeLongmontLibrary();
    let count = 0;
    for (const ev of events) {
      await upsertEvent(env, ev);
      count++;
    }
    if (count === 0) {
      // These programs run almost every day \u2014 zero matches almost
      // certainly means the page structure changed, not that nothing's
      // happening. Fail loudly rather than silently doing nothing.
      results.push({ source: "Longmont Public Library", status: "error", error: "0 events matched \u2014 check LONGMONT_EVENT_LINK_RE / title allowlist against the live page" });
    } else {
      results.push({ source: "Longmont Public Library", status: "ok", eventsUpserted: count });
    }
  } catch (err) {
    results.push({ source: "Longmont Public Library", status: "error", error: String(err) });
  }
  await logJobRun(env, "longmont-scrape", results.some((r) => r.status === "error") ? "error" : "ok", results);
  return results;
}

// ---------------------------------------------------------------------
// Louisville Public Library \u2014 CivicPlus/CivicEngage calendar. Event
// permalinks (/Home/Components/Calendar/Event/{id}/{listId}) don't embed a
// date, and the month-grid calendar view lays events out by grid position
// rather than in a way that's safe to regex without seeing the real raw
// markup \u2014 so rather than guess at that, this reads the site's own
// "Children & Family Events Calendar" list page instead, which (per manual
// inspection) renders each event with an explicit MM/DD/YYYY date range in
// plain text next to the title \u2014 the same "MM/DD/YYYY H:MM AM - MM/DD/YYYY
// H:MM PM" format used on every individual event page. Multi-day / date-
// range listings are skipped on purpose (same reasoning as the Mead
// scraper) \u2014 a single unambiguous day is required to auto-add.
// ---------------------------------------------------------------------

const LOUISVILLE_CHILDRENS_URL = "https://www.louisville-library.org/browse-find/children-s/children-s-programs";

const LOUISVILLE_TITLE_ALLOWLIST = [
  { match: /storytime/i, category: "library", age_min: 0, age_max: 5 },
  { match: /read to rover/i, category: "library", age_min: 5, age_max: 12 },
  { match: /messy art/i, category: "library", age_min: 2, age_max: 5 },
  { match: /baby social hour/i, category: "library", age_min: 0, age_max: 1.92 },
  { match: /stories in the park/i, category: "outdoor", age_min: 2, age_max: 5 },
  { match: /music\s*(&|and)\s*movement/i, category: "library", age_min: 0, age_max: 5 }
];

function louisvilleMatchTitle(title) {
  return LOUISVILLE_TITLE_ALLOWLIST.find((rule) => rule.match.test(title));
}

const LOUISVILLE_EVENT_LINK_RE = /<a\s+[^>]*href=["']([^"']*\/Home\/Components\/Calendar\/Event\/(\d+)\/(\d+)[^"']*)["'][^>]*>(.*?)<\/a>/gis;
const LOUISVILLE_DATE_RE = /(\d{2}\/\d{2}\/\d{4})\s+(\d{1,2}:\d{2}\s*[AP]M)\s*-\s*(\d{2}\/\d{2}\/\d{4})\s+(\d{1,2}:\d{2}\s*[AP]M)/i;

function parseLouisvilleChildrensHtml(html) {
  const events = [];
  let m;
  while ((m = LOUISVILLE_EVENT_LINK_RE.exec(html)) !== null) {
    const [fullMatch, href, id] = m;
    const title = decodeHtmlEntities(stripTags(m[4]));
    if (!title) continue;
    const rule = louisvilleMatchTitle(title);
    if (!rule) continue;

    const windowEnd = m.index + fullMatch.length + 300;
    const nearbyText = decodeHtmlEntities(stripTags(html.slice(m.index + fullMatch.length, windowEnd)));
    const dateMatch = nearbyText.match(LOUISVILLE_DATE_RE);
    if (!dateMatch) continue;
    const [, startDate, startLabel, endDate, endLabel] = dateMatch;
    if (startDate !== endDate) continue; // multi-day listing \u2014 needs a human, skip

    const [mo, day, year] = startDate.split("/");
    const eventDate = `${year}-${mo}-${day}`;
    const startTime = to24HourFromLabel(startLabel);
    if (!startTime) continue;
    const displayTime = `${startLabel.toUpperCase()} \u2013 ${endLabel.toUpperCase()}`;

    events.push({
      title,
      source: "Louisville Public Library",
      city: "Louisville",
      category: rule.category,
      cost: "free",
      age_min: rule.age_min,
      age_max: rule.age_max,
      day_of_week: undefined,
      start_time: startTime,
      display_time: displayTime,
      recurrence: "dated",
      event_date: eventDate,
      note: "Pulled from Louisville Public Library's Children & Family Events Calendar.",
      source_url: href.startsWith("http") ? href : `https://www.louisville-library.org${href}`,
      verified: 1,
      libcal_event_id: `louisville:${id}:${eventDate}`
    });
  }
  return events;
}

async function fetchAndNormalizeLouisvilleChildrens() {
  const res = await fetch(LOUISVILLE_CHILDRENS_URL, { headers: { "User-Agent": "PlayrouteBot/1.0 (+https://playroute.co)" } });
  if (!res.ok) throw new Error(`Louisville children's calendar fetch failed: ${res.status}`);
  const html = await res.text();
  return parseLouisvilleChildrensHtml(html);
}

async function runLouisvilleScrape(env) {
  const results = [];
  try {
    const events = await fetchAndNormalizeLouisvilleChildrens();
    let count = 0;
    for (const ev of events) {
      await upsertEvent(env, ev);
      count++;
    }
    if (count === 0) {
      results.push({ source: "Louisville Public Library", status: "error", error: "0 events matched \u2014 check LOUISVILLE_EVENT_LINK_RE / LOUISVILLE_DATE_RE against the live page" });
    } else {
      results.push({ source: "Louisville Public Library", status: "ok", eventsUpserted: count });
    }
  } catch (err) {
    results.push({ source: "Louisville Public Library", status: "error", error: String(err) });
  }
  await logJobRun(env, "louisville-scrape", results.some((r) => r.status === "error") ? "error" : "ok", results);
  return results;
}


// --- Town of Mead scraper ---
// Source feed: https://www.townofmead.org/calendar/json
// Unlike the library/rec-center feeds, this JSON has no structured date
// field (meeting_date is always empty) — the actual date/time lives buried
// in freeform HTML prose inside `body`, in wildly inconsistent formats.
// Rather than risk silently inserting a wrong date, this only auto-adds
// items where it can confidently extract a single clean "Month Day" (+
// optional time). Multi-session/recurring listings (e.g. "Thursdays from
// July 9 - July 30") are skipped on purpose — those need a human to read
// them once, same as you did manually for the Skyhawks classes.
// Mead's site structures URLs by department (e.g. /parksandrec/, /municourt/,
// /boardoftrustees/) — filtering on that path is far more reliable than
// guessing at title keywords, since it comes from how the town itself
// organizes the content rather than from us pattern-matching prose.
const MEAD_FAMILY_PATH_PREFIX = "/parksandrec/";
// Even within parksandrec, a few things aren't "fun family activity" in the
// way this app means it — registration paperwork, naming contests you don't
// attend, and solemn civic ceremonies. Excluded by title keyword.
const MEAD_TITLE_BLOCKLIST = [
  /entry form/i, /name the snowplow/i, /ceremony/i, /memorial/i, /veterans/i
];
const MEAD_MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December";

function meadDecodeEntities(str) {
  let s = String(str || "");
  // The feed double-encodes HTML entities, so unescape twice.
  for (let i = 0; i < 2; i++) {
    s = s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
         .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, " ");
  }
  return s;
}
function meadStripTags(html) {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}
// Finds one confident "Month Day[, Year]" plus an optional start time.
// Returns null (skip this item) if it can't find an unambiguous single date.
function extractMeadDateTime(text) {
  // "Month Day" (with optional ordinal suffix: "July 4th", "September 12")
  let dateMatch = text.match(new RegExp(`\\b(${MEAD_MONTHS})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "i"));
  let monthName, day;
  if (dateMatch) {
    monthName = dateMatch[1]; day = parseInt(dateMatch[2], 10);
  } else {
    // Fallback: "4th of July" / "12th of September" ordering
    const altMatch = text.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+of\\s+(${MEAD_MONTHS})\\b`, "i"));
    if (!altMatch) return null;
    day = parseInt(altMatch[1], 10); monthName = altMatch[2];
  }
  const monthNum = new Date(`${monthName} 1, 2000`).getMonth() + 1;

  // If the post mentions more than one distinct "Month Day", it's describing
  // a multi-day event (e.g. a Friday date + a separate Saturday date/time) —
  // too ambiguous to safely pick a single date+time pairing. Skip it.
  const allDateMatches = text.match(new RegExp(`\\b(${MEAD_MONTHS})\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`, "gi")) || [];
  const distinctDates = new Set(allDateMatches.map(s => s.toLowerCase().replace(/(st|nd|rd|th)\b/i, "")));
  if (distinctDates.size > 1) return null;

  // Bail out on anything that reads as a recurring/multi-date listing —
  // those are exactly the cases we don't want to guess at.
  if (/\b(thursdays|fridays|saturdays|sundays|mondays|tuesdays|wednesdays)\b/i.test(text)) return null;
  if (/\bdates?:\s*\w+\s+\d{1,2}\s*[-–]\s*\w*\s*\d{0,2}/i.test(text)) return null;

  // Time extraction, in priority order:
  // 1) A range where BOTH ends have their own am/pm ("11 a.m. to 3 p.m.") — use the first directly.
  // 2) A range with only a trailing am/pm ("4 to 9:30 p.m.") — infer the start's period rather
  //    than mistakenly grabbing the end time as if it were the start.
  // 3) A single standalone time.
  let startTime = null, displayHour = null;
  const bothMarked = text.match(/(\d{1,2})(:\d{2})?\s*(a\.m\.|p\.m\.|am|pm)\s*(?:to|-|–)\s*\d{1,2}(:\d{2})?\s*(?:a\.m\.|p\.m\.|am|pm)/i);
  const trailingOnly = !bothMarked && text.match(/(\d{1,2})(:\d{2})?\s*(?:to|-|–)\s*(\d{1,2})(:\d{2})?\s*(a\.m\.|p\.m\.|am|pm)/i);
  const singleTime = !bothMarked && !trailingOnly && text.match(/(\d{1,2})(:\d{2})?\s*(a\.m\.|p\.m\.|am|pm)/i);

  let h = null, min = "00", isPM = null;
  if (bothMarked) {
    h = parseInt(bothMarked[1], 10); min = bothMarked[2] ? bothMarked[2].slice(1) : "00";
    isPM = /p/i.test(bothMarked[3]);
  } else if (trailingOnly) {
    const startHour = parseInt(trailingOnly[1], 10);
    const endHour = parseInt(trailingOnly[3], 10);
    const endIsPM = /p/i.test(trailingOnly[5]);
    h = startHour; min = trailingOnly[2] ? trailingOnly[2].slice(1) : "00";
    // If the start hour is <= the end hour, they share the same period.
    // If start > end numerically (e.g. "11 to 1 p.m." = 11am-1pm), the
    // start must be the opposite period (crosses noon).
    isPM = startHour <= endHour ? endIsPM : !endIsPM;
  } else if (singleTime) {
    h = parseInt(singleTime[1], 10); min = singleTime[2] ? singleTime[2].slice(1) : "00";
    isPM = /p/i.test(singleTime[3]);
  }
  if (h !== null) {
    if (isPM && h < 12) h += 12;
    if (!isPM && h === 12) h = 0;
    startTime = `${String(h).padStart(2, "0")}:${min}`;
    displayHour = { h, min };
  }
  return { monthNum, day, startTime, displayHour };
}
function meadDisplayTime(displayHour) {
  if (!displayHour) return "Check listing for time";
  const { h, min } = displayHour;
  const period = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${min} ${period}`;
}

async function fetchAndNormalizeMeadCalendar() {
  const res = await fetch("https://www.townofmead.org/calendar/json");
  if (!res.ok) throw new Error(`Mead calendar fetch failed: ${res.status}`);
  const items = await res.json();

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const lookAheadCutoff = new Date(startOfToday.getTime() + 90 * 86400000);
  const currentYear = now.getFullYear();

  const events = [];
  const needsReview = []; // family-relevant items that couldn't be confidently auto-parsed
  for (const item of items) {
    const title = (item.title || "").trim();
    if (!title) continue;
    if (!(item.link || "").startsWith(MEAD_FAMILY_PATH_PREFIX)) continue; // civic/court/board content lives elsewhere on the site
    if (MEAD_TITLE_BLOCKLIST.some(re => re.test(title))) continue;

    const plainBody = meadStripTags(meadDecodeEntities(item.body || ""));
    const parsed = extractMeadDateTime(plainBody);
    if (!parsed) {
      // Passed the family-relevance filter but couldn't confidently parse a
      // single clean date (recurring/multi-session listing, ambiguous
      // phrasing, etc.) — rather than silently dropping it, surface it for
      // a human to look at once, instead of guessing.
      needsReview.push({
        title,
        source: "Town of Mead Parks & Recreation",
        city: "Mead",
        note: plainBody.slice(0, 300),
        source_url: `https://www.townofmead.org${item.link}`,
        dedup_key: `mead-review:${item.id}`
      });
      continue;
    }

    // Try this year first; if that's already passed, try next year (handles
    // items posted late in the year for an early-next-year date).
    let eventDate = new Date(currentYear, parsed.monthNum - 1, parsed.day);
    if (eventDate < startOfToday) {
      eventDate = new Date(currentYear + 1, parsed.monthNum - 1, parsed.day);
    }
    if (eventDate < startOfToday || eventDate > lookAheadCutoff) continue;

    const dayOfWeek = eventDate.toLocaleDateString("en-US", { weekday: "long" });
    const eventDateStr = `${eventDate.getFullYear()}-${String(eventDate.getMonth() + 1).padStart(2, "0")}-${String(eventDate.getDate()).padStart(2, "0")}`;
    const startTime = parsed.startTime || "09:00";
    const displayTime = meadDisplayTime(parsed.displayHour);

    events.push({
      title,
      source: "Town of Mead Parks & Recreation",
      city: "Mead",
      category: "outdoor",
      cost: "free",
      age_min: 0,
      age_max: 12,
      day_of_week: dayOfWeek,
      start_time: startTime,
      display_time: displayTime,
      recurrence: "dated",
      event_date: eventDateStr,
      note: plainBody.slice(0, 300),
      source_url: `https://www.townofmead.org${item.link}`,
      verified: 0, // auto-parsed from prose — flagged unverified, unlike hand-curated entries
      libcal_event_id: `mead:${item.id}`
    });
  }
  return { events, needsReview };
}

async function runMeadScrape(env) {
  const results = [];
  try {
    const { events } = await fetchAndNormalizeMeadCalendar();
    let count = 0;
    for (const ev of events) {
      await upsertEvent(env, ev);
      count++;
    }
    results.push({ source: "Town of Mead", status: "ok", eventsUpserted: count });
  } catch (err) {
    results.push({ source: "Town of Mead", status: "error", error: String(err) });
  }
  await logJobRun(env, "mead-scrape", results.some((r) => r.status === "error") ? "error" : "ok", results);
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

// --- Weekly Active Users tracking ---
// Privacy-friendly: hashes IP + User-Agent with a salt that rotates every
// Monday, so the same visitor gets a stable hash within one week (counted
// once for that week's WAU) but a different, unlinkable hash the next week.
// No cookies, no persistent client-side ID, nothing stored that identifies
// a specific person across weeks.
function currentWeekSalt() {
  // Mountain-Time-anchored so the hash rotates at Monday midnight MT, not
  // UTC Monday — otherwise a visitor near the day boundary could get an
  // inconsistent hash relative to what "this week" means for them.
  const mtNow = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
  const day = mtNow.getDay() || 7; // Mon=1..Sun=7
  mtNow.setDate(mtNow.getDate() - day + 1); // back up to Monday of this week, MT
  return `${mtNow.getFullYear()}-${String(mtNow.getMonth() + 1).padStart(2, "0")}-${String(mtNow.getDate()).padStart(2, "0")}`;
}

// Formats a Date as 'YYYY-MM-DD HH:MM:SS' in UTC, matching the string format
// SQLite's CURRENT_TIMESTAMP produces (page_views.viewed_at's default) — the
// stats queries below compare against this as plain strings, so the format
// has to line up exactly.
function toSqliteUTCString(date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}
function mtCalendarDateStr(mtDate) {
  return `${mtDate.getFullYear()}-${String(mtDate.getMonth() + 1).padStart(2, "0")}-${String(mtDate.getDate()).padStart(2, "0")}`;
}
// Start of "today" in Mountain Time, expressed as the equivalent UTC instant.
// Reuses toMountainDate (already DST-aware) rather than converting directly,
// since a naive toISOString() on a reinterpreted-timezone Date silently
// applies zero offset instead of the real +/-6 or 7 hour Mountain offset.
function mountainMidnightTodayUTC() {
  const mtNow = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
  return toSqliteUTCString(toMountainDate(mtCalendarDateStr(mtNow), 0, 0));
}
// Start of "this week" (Monday) in Mountain Time, as the equivalent UTC instant.
function mountainMidnightThisWeekUTC() {
  const mtNow = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
  const day = mtNow.getDay() || 7;
  mtNow.setDate(mtNow.getDate() - day + 1);
  return toSqliteUTCString(toMountainDate(mtCalendarDateStr(mtNow), 0, 0));
}

async function hashVisitor(request) {
  const ip = request.headers.get("CF-Connecting-IP") || "";
  const ua = request.headers.get("User-Agent") || "";
  const data = new TextEncoder().encode(`${ip}|${ua}|${currentWeekSalt()}`);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function handlePageView(request, env) {
  const visitorHash = await hashVisitor(request);
  const cf = request.cf || {};
  const ua = request.headers.get("User-Agent") || "";
  const deviceType = /Mobi|Android/i.test(ua) ? "mobile" : "desktop";
  let source = null;
  try {
    const body = await request.json();
    if (body && body.source) source = String(body.source).slice(0, 50);
  } catch { /* no body / not JSON — fine, organic visit */ }
  await env.DB.prepare(
    `INSERT INTO page_views (visitor_hash, city, country, device_type, source) VALUES (?, ?, ?, ?, ?)`
  ).bind(visitorHash, cf.city || null, cf.country || null, deviceType, source).run();
  return json({ ok: true });
}

async function handleStats(env) {
  const todayStart = mountainMidnightTodayUTC();
  const weekStart = mountainMidnightThisWeekUTC();

  const dau = await env.DB.prepare(
    `SELECT COUNT(DISTINCT visitor_hash) AS n FROM page_views WHERE viewed_at >= ?`
  ).bind(todayStart).first();
  const wau = await env.DB.prepare(
    `SELECT COUNT(DISTINCT visitor_hash) AS n FROM page_views WHERE viewed_at >= ?`
  ).bind(weekStart).first();
  const totalViewsThisWeek = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM page_views WHERE viewed_at >= ?`
  ).bind(weekStart).first();
  const byDevice = await env.DB.prepare(
    `SELECT device_type, COUNT(DISTINCT visitor_hash) AS n FROM page_views WHERE viewed_at >= ? GROUP BY device_type`
  ).bind(weekStart).all();
  const byCity = await env.DB.prepare(
    `SELECT city, COUNT(DISTINCT visitor_hash) AS n FROM page_views WHERE viewed_at >= ? AND city IS NOT NULL GROUP BY city ORDER BY n DESC LIMIT 10`
  ).bind(weekStart).all();

  // Visits that came specifically from clicking the link in a digest email
  // (tagged ?src=newsletter) — lets you see whether the newsletter is
  // actually driving people back into the app, separate from organic visits.
  const newsletterVisits1d = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM page_views WHERE viewed_at >= ? AND source = 'newsletter'`
  ).bind(todayStart).first();
  const newsletterVisits7d = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM page_views WHERE viewed_at >= ? AND source = 'newsletter'`
  ).bind(weekStart).first();
  const newsletterVisitors7d = await env.DB.prepare(
    `SELECT COUNT(DISTINCT visitor_hash) AS n FROM page_views WHERE viewed_at >= ? AND source = 'newsletter'`
  ).bind(weekStart).first();

  // Click tracking (source links, "Open in Maps" on playgrounds/hikes, and
  // the support/feedback links) grouped by category — 1-day and 7-day windows.
  const clicksByType1d = await env.DB.prepare(
    `SELECT category, COUNT(*) AS n FROM link_clicks WHERE clicked_at >= ? GROUP BY category ORDER BY n DESC`
  ).bind(todayStart).all();
  const clicksByType7d = await env.DB.prepare(
    `SELECT category, COUNT(*) AS n FROM link_clicks WHERE clicked_at >= ? GROUP BY category ORDER BY n DESC`
  ).bind(weekStart).all();
  const totalClicks1d = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM link_clicks WHERE clicked_at >= ?`
  ).bind(todayStart).first();
  const totalClicks7d = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM link_clicks WHERE clicked_at >= ?`
  ).bind(weekStart).first();

  return json({
    weekly_active_users: wau?.n || 0,
    daily_active_users: dau?.n || 0,
    page_views_7d: totalViewsThisWeek?.n || 0,
    by_device_7d: byDevice.results || [],
    top_cities_7d: byCity.results || [],
    newsletter_visits_1d: newsletterVisits1d?.n || 0,
    newsletter_visits_7d: newsletterVisits7d?.n || 0,
    newsletter_unique_visitors_7d: newsletterVisitors7d?.n || 0,
    link_clicks_1d: totalClicks1d?.n || 0,
    link_clicks_7d: totalClicks7d?.n || 0,
    link_clicks_by_type_1d: clicksByType1d.results || [],
    link_clicks_by_type_7d: clicksByType7d.results || []
  });
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
  await logJobRun(env, "libcal-scrape", results.some((r) => r.status === "error") ? "error" : "ok", results);
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
  await logJobRun(env, "ical-scrape", results.some((r) => r.status === "error") ? "error" : "ok", results);
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

// Records that a scrape/scan job ran, so the admin page can always show
// real last-run status instead of only what a manual "run now" button
// happened to return in that one browser session. Logging failures are
// swallowed on purpose — a broken job_runs insert should never take down
// the actual scrape.
async function logJobRun(env, jobName, status, details) {
  try {
    await env.DB.prepare(
      `INSERT INTO job_runs (job_name, status, details) VALUES (?, ?, ?)`
    ).bind(jobName, status, details ? JSON.stringify(details) : null).run();
  } catch (err) {
    console.error(`logJobRun failed for ${jobName}:`, err);
  }
}

// Single source of truth describing every scraper that's actually wired up
// in code (as opposed to `scrape_sources`, which is a hand-maintained
// registry of sources someone has looked at — some coded, many still
// manual). Keep this in sync with LIBCAL_LIBRARIES / ICAL_LIBRARIES /
// WOW_MUSEUM / the Mead scraper above whenever one of those changes.
const AUTOMATED_SOURCES = [
  {
    job_name: "libcal-scrape",
    label: "LibCal API",
    cities: LIBCAL_LIBRARIES.map((l) => l.city),
    scope: "Structured event feed via each library's LibCal API (birth\u20135 audience where the API supports filtering).",
    cadence: "Daily (cron) + on-demand via \u201cRun all scrapers now\u201d"
  },
  {
    job_name: "ical-scrape",
    label: "iCal feed",
    cities: ICAL_LIBRARIES.map((l) => l.city),
    scope: "Same libraries as LibCal API, pulled via public .ics subscription feed as a second, independent pass.",
    cadence: "Daily (cron) + on-demand via \u201cRun all scrapers now\u201d"
  },
  {
    job_name: "html-scrape",
    label: "HTML calendar scrape",
    cities: [WOW_MUSEUM.city],
    scope: "WOW Children's Museum \u2014 parses the museum's own calendar.html pages (current month + next 2).",
    cadence: "Daily (cron) + on-demand via \u201cRun all scrapers now\u201d"
  },
  {
    job_name: "mead-scrape",
    label: "JSON calendar feed",
    cities: ["Mead"],
    scope: "Town of Mead \u2014 auto-adds only events with an unambiguous single date/time from /parksandrec/ posts; anything ambiguous or recurring is left for the pending-events check below instead of being guessed at.",
    cadence: "Daily (cron) + on-demand via \u201cRun all scrapers now\u201d"
  },
  {
    job_name: "longmont-scrape",
    label: "HTML calendar scrape (Tribe Events Calendar)",
    cities: ["Longmont"],
    scope: "Reads the library category page's event links, which embed their date directly in the URL. Only auto-adds titles matching a known, pre-verified recurring program (storytimes, stay & play, Read to Rover, etc.) \u2014 one-off named specials are intentionally skipped and need a manual look. Confidence: written without access to this site's raw HTML in the build environment \u2014 first live run should be checked for a 0-result error before trusting it.",
    cadence: "Daily (cron) + on-demand via \u201cRun all scrapers now\u201d"
  },
  {
    job_name: "louisville-scrape",
    label: "HTML calendar scrape (Children & Family list page)",
    cities: ["Louisville"],
    scope: "Reads the library's Children & Family Events Calendar list page, which prints an explicit MM/DD/YYYY date next to each title. Only auto-adds titles matching a known children's program name; multi-day listings and unrecognized titles are skipped. Confidence: written without access to this site's raw HTML in the build environment \u2014 first live run should be checked for a 0-result error before trusting it.",
    cadence: "Daily (cron) + on-demand via \u201cRun all scrapers now\u201d"
  },
  {
    job_name: "pending-events-scan",
    label: "Pending-events review scan",
    cities: ["Mead"],
    scope: "Re-checks Mead's calendar for anything the scraper above skipped (recurring/multi-date/ambiguous listings) and emails a review link for each candidate \u2014 nothing here is auto-added to the live events table without a manual Approve.",
    cadence: "Sundays ~noon MT (cron) + on-demand via \u201cRun pending-events scan now\u201d"
  }
];

async function handleSourceRegistry(env) {
  const { results: manual } = await env.DB.prepare("SELECT * FROM scrape_sources ORDER BY city").all();
  const jobNames = AUTOMATED_SOURCES.map((s) => s.job_name);
  const placeholders = jobNames.map(() => "?").join(",");
  const { results: lastRuns } = await env.DB.prepare(
    `SELECT job_name, ran_at, status, details FROM job_runs
     WHERE job_name IN (${placeholders})
     AND id IN (SELECT MAX(id) FROM job_runs WHERE job_name IN (${placeholders}) GROUP BY job_name)`
  ).bind(...jobNames, ...jobNames).all();
  const lastRunByJob = Object.fromEntries(lastRuns.map((r) => [r.job_name, r]));
  const automated = AUTOMATED_SOURCES.map((s) => {
    const last = lastRunByJob[s.job_name];
    return {
      ...s,
      last_run_at: last?.ran_at ?? null,
      last_run_status: last?.status ?? "never run",
      last_run_details: last?.details ? JSON.parse(last.details) : null
    };
  });
  return json({ automated, manual });
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

const DIGEST_SITE_URL = "https://playroute.co";
const DIGEST_MAX_PER_DAY = 6;
const DIGEST_MAX_DAYS = 5;

// Mirrors the category colors used in the app itself (see the --* and
// .tag.* definitions in public/index.html) so the email feels like the same
// product. Deliberately NOT using emoji here — color-emoji rendering is
// inconsistent across email clients (some show monochrome outline glyphs,
// some show tofu/missing-glyph boxes), so a plain color bar + text label is
// the safer choice for something that has to look right everywhere.
const DIGEST_CATEGORY_META = {
  library:        { label: "Library",        color: "#7A5568" },
  rec:            { label: "Rec & Fitness",  color: "#6E8B8A" },
  museum:         { label: "Museum",         color: "#C79A4B" },
  outdoor:        { label: "Outdoor",        color: "#B4805A" },
  community:      { label: "Community",      color: "#9B8AAE" },
  farmers_market: { label: "Farmers Market", color: "#B85C4A" }
};
function digestCategoryMeta(category) {
  return DIGEST_CATEGORY_META[category] || { label: "Event", color: "#9B5C2A" };
}

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

  // Group by day, capping how many show per day so the email stays
  // skimmable \u2014 but keep the real total too, so the email can honestly
  // say "+N more today" instead of silently implying the shown list is
  // everything happening.
  const byDay = new Map();
  for (const ev of withOccurrence) {
    const entry = byDay.get(ev.occurrence_label) || { events: [], totalCount: 0 };
    entry.totalCount++;
    if (entry.events.length < DIGEST_MAX_PER_DAY) entry.events.push(ev);
    byDay.set(ev.occurrence_label, entry);
  }
  return byDay;
}

function buildDigestHtml(byDay, unsubscribeUrl) {
  const days = [...byDay.entries()];

  const dayBlocks = days.map(([label, { events: evs, totalCount }]) => {
    const cards = evs.map((ev) => {
      const meta = digestCategoryMeta(ev.category);
      const costPill = ev.cost === "free"
        ? `<span style="display:inline-block;font-family:'DM Sans',Arial,sans-serif;font-size:10.5px;font-weight:600;padding:2px 7px;border-radius:5px;background:#D4EBC9;color:#3A5C2A;">Free</span>`
        : `<span style="display:inline-block;font-family:'DM Sans',Arial,sans-serif;font-size:10.5px;font-weight:600;padding:2px 7px;border-radius:5px;background:#E8DED0;color:#5C4A38;">Paid</span>`;
      const cityPill = `<span style="display:inline-block;font-family:'DM Sans',Arial,sans-serif;font-size:10.5px;font-weight:600;padding:2px 7px;border-radius:5px;background:#9B5C2A;color:#ffffff;margin-right:5px;">${escapeHtml(ev.city)}</span>`;

      return `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;margin-bottom:7px;">
        <tr>
          <td width="4" style="background:${meta.color};border-radius:5px 0 0 5px;font-size:0;line-height:0;">&nbsp;</td>
          <td style="background:#EDE2CA;border-top:1px solid #C8BA9E;border-right:1px solid #C8BA9E;border-bottom:1px solid #C8BA9E;border-radius:0 5px 5px 0;padding:9px 12px;">
            <div style="font-family:Georgia,'Times New Roman',serif;font-weight:700;font-size:14.5px;color:#2C1F14;line-height:1.25;">${escapeHtml(ev.title)}</div>
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:5px;">
              <tr>
                <td style="font-family:Consolas,'Courier New',monospace;font-weight:700;font-size:12px;color:#5C3A1E;padding-right:8px;white-space:nowrap;">${escapeHtml(ev.display_time)}</td>
                <td>${cityPill}${costPill}</td>
              </tr>
            </table>
          </td>
        </tr>
      </table>`;
    }).join("");

    const overflow = totalCount > evs.length
      ? `<div style="font-family:'DM Sans',Arial,sans-serif;font-size:11.5px;color:#7A6650;font-style:italic;margin:2px 0 4px 4px;">+${totalCount - evs.length} more that day in the app \u2192</div>`
      : "";

    return `
      <div style="font-family:'DM Sans',Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#9B5C2A;border-bottom:1px solid #C8BA9E;padding-bottom:5px;margin:18px 0 9px;">${escapeHtml(label)}</div>
      ${cards}${overflow}`;
  }).join("");

  const bodyContent = days.length
    ? dayBlocks
    : `<p style="font-family:'DM Sans',Arial,sans-serif;color:#7A6650;font-size:13px;">No events loaded for the next few days yet \u2014 check the app directly.</p>`;

  return `
  <div style="background:#EDE2CA;padding:24px 12px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;">
      <tr><td style="background:#F5EDD8;border-radius:16px;padding:22px 18px 18px;">
        <div style="text-align:center;">
          <span style="font-family:Georgia,'Times New Roman',serif;font-weight:700;font-size:22px;color:#2C1F14;">Playroute</span>
        </div>
        <p style="text-align:center;color:#7A6650;font-family:'DM Sans',Arial,sans-serif;font-size:12.5px;margin:3px 0 16px;">A sneak peek at what's coming up for the kids \u2014 see everything in the app.</p>
        ${bodyContent}
        <div style="text-align:center;margin:20px 0 12px;">
          <a href="${DIGEST_SITE_URL}/?src=newsletter" style="display:inline-block;background:#2C1F14;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:9px;font-family:'DM Sans',Arial,sans-serif;font-size:13.5px;font-weight:600;">Open Playroute \u2192</a>
        </div>
        <p style="text-align:center;font-family:'DM Sans',Arial,sans-serif;font-size:11px;color:#B5A88F;margin-top:14px;">You're getting this because you subscribed to Playroute's weekly digest. <a href="${unsubscribeUrl}" style="color:#B5A88F;">Unsubscribe</a></p>
      </td></tr>
    </table>
  </div>`;
}

function buildDigestText(byDay) {
  const lines = ["Playroute \u2014 a sneak peek at what's coming up for the kids (see everything in the app)", ""];
  for (const [label, { events: evs, totalCount }] of byDay.entries()) {
    lines.push(label.toUpperCase());
    for (const ev of evs) {
      lines.push(`- ${ev.title} \u2014 ${ev.display_time} \u00B7 ${ev.city} \u00B7 ${ev.cost === "free" ? "Free" : "Paid"}`);
    }
    if (totalCount > evs.length) {
      lines.push(`+${totalCount - evs.length} more that day in the app`);
    }
    lines.push("");
  }
  lines.push(`Open Playroute: ${DIGEST_SITE_URL}/?src=newsletter`);
  return lines.join("\n");
}

async function sendDigestEmail(env, toEmail, html, text, subject = "This week on Playroute \uD83C\uDF33") {
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
      subject,
      html,
      text
    })
  });
  if (!res.ok) {
    throw new Error(`Resend send failed for ${toEmail}: ${res.status} ${await res.text()}`);
  }
}

async function runWeeklyDigest(env, testEmail = null) {
  const byDay = await getWeekAheadEvents(env);

  if (testEmail) {
    // Test mode: send to exactly one address, real content, without
    // touching the subscribers table or anyone's real subscription at all.
    const unsubscribeUrl = `${DIGEST_SITE_URL}/api/unsubscribe?email=${encodeURIComponent(testEmail)}`;
    const html = buildDigestHtml(byDay, unsubscribeUrl);
    const text = buildDigestText(byDay);
    try {
      await sendDigestEmail(env, testEmail, html, text, "[TEST] This week on Playroute \uD83C\uDF33");
      return [{ email: testEmail, status: "sent (test)" }];
    } catch (err) {
      return [{ email: testEmail, status: "error", error: String(err) }];
    }
  }

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

async function runPendingEventsScan(env) {
  const results = [];
  let newCandidates = 0;
  try {
    const { needsReview } = await fetchAndNormalizeMeadCalendar();
    for (const item of needsReview) {
      // Skip anything whose title+city already exists in the live events
      // table — otherwise something already manually reviewed and added
      // (e.g. because its real single date got buried among other unrelated
      // dates on the page, like a vendor-registration deadline) would keep
      // getting re-suggested every week.
      const already = await env.DB.prepare(
        `SELECT 1 FROM events WHERE title = ? AND city = ? LIMIT 1`
      ).bind(item.title, item.city).first();
      if (already) continue;

      const token = crypto.randomUUID();
      const res = await env.DB.prepare(
        `INSERT INTO pending_events (title, source, city, note, source_url, raw_excerpt, dedup_key, approval_token)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(dedup_key) DO NOTHING`
      ).bind(item.title, item.source, item.city, item.note, item.source_url, item.note, item.dedup_key, token).run();
      if (res.meta.changes > 0) newCandidates++;
    }
    results.push({ source: "Mead (needs review)", status: "ok", newCandidates });
  } catch (err) {
    results.push({ source: "Mead (needs review)", status: "error", error: String(err) });
  }

  // Only email if there's something to actually review — no empty "nothing
  // found this week" noise.
  const { results: pending } = await env.DB.prepare(
    `SELECT * FROM pending_events WHERE status = 'pending' ORDER BY discovered_at DESC`
  ).all();
  if (pending.length > 0 && env.ADMIN_EMAIL) {
    const html = buildPendingEventsEmailHtml(pending);
    try {
      await sendDigestEmail(env, env.ADMIN_EMAIL, html, null, "New events to review on Playroute");
      results.push({ source: "pending-events-email", status: "sent", count: pending.length });
    } catch (err) {
      results.push({ source: "pending-events-email", status: "error", error: String(err) });
    }
  }
  await logJobRun(env, "pending-events-scan", results.some((r) => r.status === "error") ? "error" : "ok", results);
  return results;
}

function buildPendingEventsEmailHtml(pending) {
  const rows = pending.map(p => `
    <tr><td style="padding:16px 0;border-bottom:1px solid #eee;font-family:sans-serif;">
      <div style="font-size:15px;font-weight:600;color:#2c1f14;">${escapeHtml(p.title)}</div>
      <div style="font-size:12px;color:#8a7a63;margin:2px 0 8px;">${escapeHtml(p.city || "")} ${p.source ? "· " + escapeHtml(p.source) : ""}</div>
      <div style="font-size:13px;color:#5c4a38;margin-bottom:10px;">${escapeHtml((p.note || "").slice(0, 200))}</div>
      ${p.source_url ? `<div style="font-size:12px;margin-bottom:10px;"><a href="${p.source_url}" style="color:#9b5c2a;">View original listing ↗</a></div>` : ""}
      <a href="${DIGEST_SITE_URL}/api/approve-pending?token=${p.approval_token}" style="display:inline-block;background:#2c1f14;color:#fff;text-decoration:none;padding:8px 16px;border-radius:6px;font-size:13px;font-family:sans-serif;margin-right:8px;">Approve</a>
      <a href="${DIGEST_SITE_URL}/api/reject-pending?token=${p.approval_token}" style="display:inline-block;background:#eee;color:#5c4a38;text-decoration:none;padding:8px 16px;border-radius:6px;font-size:13px;font-family:sans-serif;">Reject</a>
    </td></tr>`).join("");

  return `
  <div style="max-width:520px;margin:0 auto;font-family:sans-serif;">
    <h1 style="font-family:serif;font-size:20px;color:#2c1f14;">New events to review</h1>
    <p style="color:#8a7a63;font-size:13px;">Found on Mead's calendar but couldn't be auto-added with confidence — take a look and approve or reject each one.</p>
    <table width="100%" cellpadding="0" cellspacing="0">${rows}</table>
  </div>`;
}

async function handleApprovePending(env, url) {
  const token = url.searchParams.get("token");
  if (!token) return new Response("Missing token", { status: 400 });
  const row = await env.DB.prepare(`SELECT * FROM pending_events WHERE approval_token = ? AND status = 'pending'`).bind(token).first();
  if (!row) return new Response("This item was already handled or doesn't exist.", { headers: { "Content-Type": "text/plain" } });

  await upsertEvent(env, {
    title: row.title,
    source: row.source,
    city: row.city,
    category: row.category || "outdoor",
    cost: row.cost || "free",
    age_min: row.age_min ?? 0,
    age_max: row.age_max ?? 12,
    day_of_week: row.day_of_week,
    start_time: row.start_time,
    display_time: row.display_time,
    recurrence: row.recurrence || "dated",
    event_date: row.event_date,
    note: row.note,
    source_url: row.source_url,
    verified: 0,
    libcal_event_id: row.dedup_key
  });
  await env.DB.prepare(`UPDATE pending_events SET status = 'approved', decided_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(row.id).run();
  return new Response(`"${row.title}" has been added to Playroute. Thanks for reviewing!`, { headers: { "Content-Type": "text/plain" } });
}

async function handleRejectPending(env, url) {
  const token = url.searchParams.get("token");
  if (!token) return new Response("Missing token", { status: 400 });
  const res = await env.DB.prepare(`UPDATE pending_events SET status = 'rejected', decided_at = CURRENT_TIMESTAMP WHERE approval_token = ? AND status = 'pending'`).bind(token).run();
  if (res.meta.changes === 0) return new Response("This item was already handled or doesn't exist.", { headers: { "Content-Type": "text/plain" } });
  return new Response("Got it — dismissed and won't be suggested again.", { headers: { "Content-Type": "text/plain" } });
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
    if (event.cron === "0 18 * * 7" || event.cron === "0 19 * * 7") {
      if (isNearNoonMountain(new Date())) {
        ctx.waitUntil(runWeeklyDigest(env));
        ctx.waitUntil(runPendingEventsScan(env));
      }
      return;
    }
    ctx.waitUntil(runScrape(env));
    ctx.waitUntil(runICalScrape(env));
    ctx.waitUntil(runHtmlScrape(env));
    ctx.waitUntil(runMeadScrape(env));
    ctx.waitUntil(runLongmontScrape(env));
    ctx.waitUntil(runLouisvilleScrape(env));
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
      if (url.pathname === "/api/source-registry") return await handleSourceRegistry(env);
      if (url.pathname.startsWith("/api/photos/")) {
        return await handlePhoto(env, decodeURIComponent(url.pathname.slice("/api/photos/".length)));
      }
      if (url.pathname === "/api/track-click" && request.method === "POST") return await handleTrackClick(request, env);
      if (url.pathname === "/api/pageview" && request.method === "POST") return await handlePageView(request, env);
      if (url.pathname === "/api/stats") return await handleStats(env);
      if (url.pathname === "/robots.txt") {
        return new Response(
          "User-agent: *\nAllow: /\nSitemap: https://playroute.co/sitemap.xml\n",
          { headers: { "Content-Type": "text/plain", ...CORS_HEADERS } }
        );
      }
      if (url.pathname === "/sitemap.xml") {
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url>\n    <loc>https://playroute.co/</loc>\n    <changefreq>daily</changefreq>\n    <priority>1.0</priority>\n  </url>\n</urlset>\n`,
          { headers: { "Content-Type": "application/xml", ...CORS_HEADERS } }
        );
      }
      if (url.pathname === "/api/scrape-now" && request.method === "POST") {
        const [apiResults, icalResults, htmlResults, meadResults, longmontResults, louisvilleResults] = await Promise.all([
          runScrape(env),
          runICalScrape(env),
          runHtmlScrape(env),
          runMeadScrape(env),
          runLongmontScrape(env),
          runLouisvilleScrape(env)
        ]);
        return json({ ranAt: new Date().toISOString(), apiResults, icalResults, htmlResults, meadResults, longmontResults, louisvilleResults });
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
        const testEmail = url.searchParams.get("email");
        const results = await runWeeklyDigest(env, testEmail);
        return json({ ranAt: new Date().toISOString(), mode: testEmail ? "test" : "all-subscribers", results });
      }
      if (url.pathname === "/api/approve-pending") {
        return await handleApprovePending(env, url);
      }
      if (url.pathname === "/api/reject-pending") {
        return await handleRejectPending(env, url);
      }
      if (url.pathname === "/api/pending-scan-now" && request.method === "POST") {
        const results = await runPendingEventsScan(env);
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
