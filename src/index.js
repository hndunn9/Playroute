import { validateCandidate, buildStableDedupKey, ingestCandidate, runSources, SOURCE_RUNNERS } from "./pipeline.js";
// Re-exported (not just defined in its own file) because wrangler.jsonc's
// workflows binding points at class_name "EventDiscoveryWorkflow", and
// Cloudflare resolves that against whatever this file (the `main` entry
// point) exports -- a class sitting in discovery-workflow.js alone,
// without this re-export, would be invisible to the platform.
export { EventDiscoveryWorkflow } from "./discovery-workflow.js";

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


function unfoldICal(text) {
  return text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
}

function unescapeICalText(s) {
  if (!s) return s;
  // Real bug found 2026-07-18: some source feeds (High Plains Library
  // District, Erie Chamber of Commerce, City of Louisville all confirmed)
  // encode punctuation like em/en dashes as literal `\u2014`/`\u2013`
  // sequences in the raw ICS text. That's not standard iCal TEXT escaping
  // (which only defines \n \, \; \\), so it was passing straight through
  // into title/source/display_time/note as literal backslash-u-XXXX
  // characters instead of the real glyph. Decode those first, before the
  // \\ -> \ unescape below would otherwise leave them looking like a
  // dangling escaped backslash + "uXXXX" text.
  return s
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\n/g, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
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

// FIX (2026-07-14): the previous to24Hour()/formatDisplayTime() used raw
// date.getUTCHours() / timeZone:"UTC" — meaning every Boulder/Erie iCal
// event's stored time was the literal UTC clock time, not the Mountain
// Time it actually happens at. A real 10:30am MT event (exported as
// 16:30 UTC) was being stored and displayed as "16:30" / "4:30 PM" —
// exactly 6 hours later than reality during MDT. Same formatToParts-based
// technique as toMountainDate() above, which is already known-correct.
function to24Hour(date, timeZone = TZ) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(date);
  const p = Object.fromEntries(parts.filter((x) => x.type !== "literal").map((x) => [x.type, x.value]));
  const hh = String(Number(p.hour) % 24).padStart(2, "0"); // guards the rare "24:00" formatToParts quirk
  return `${hh}:${p.minute}`;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function formatDisplayTime(start, end, timeZone = TZ) {
  const fmt = (d) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
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
  // day_of_week and event_date must also be computed in Mountain Time, not
  // UTC — an event at, say, 11pm MT Tuesday is already Wednesday in UTC,
  // so using .getUTCDay()/.toISOString() directly would mislabel it.
  const mtDateStr = toMountainDateStr(ev.dtstart);
  const mtDayOfWeek = DAY_NAMES[new Date(`${mtDateStr}T12:00:00Z`).getUTCDay()];
  return {
    title: ev.summary,
    source: `${city} Public Library${ev.location ? " \u2014 " + ev.location : ""}`,
    city,
    category: "library",
    cost: "free",
    age_min,
    age_max,
    day_of_week: mtDayOfWeek,
    start_time: to24Hour(ev.dtstart),
    display_time: formatDisplayTime(ev.dtstart, ev.dtend),
    recurrence: "dated",
    event_date: mtDateStr,
    note: truncateAtBoundary((ev.description || "").replace(/<[^>]+>/g, ""), 300) || `Pulled from ${city} library's public iCal feed.`,
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

// Every scraper that stores free-text descriptions (`note` field) must run
// long text through this instead of a bare .slice(0, N) -- a hard slice cuts
// mid-word/mid-sentence (this is exactly how ~256 events, e.g. "Toddler
// Explorers", ended up visibly cut off: multiple scrapers each had their own
// unbounded `.slice(0, 300)`). This backs off to the nearest sentence end
// within the last ~40% of the budget, else the nearest word boundary, and
// appends an ellipsis so a truncation is visibly a truncation rather than
// looking like a complete-but-abrupt sentence.
function truncateAtBoundary(text, maxLen = 300) {
  const s = (text || "").trim();
  if (s.length <= maxLen) return s;
  const cut = s.slice(0, maxLen);
  const lastSentenceEnd = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (lastSentenceEnd > maxLen * 0.6) return cut.slice(0, lastSentenceEnd + 1).trim();
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > maxLen * 0.6 ? cut.slice(0, lastSpace) : cut).trim() + "\u2026";
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

// WOW's list/calendar page only gives title + time in each link — the real
// program description lives on each event's own detail page. These are the
// site's repeated sidebar/CTA strings that show up on every detail page
// (membership pitch, donation ask, rental blurb, registration-capacity
// note) — stripped out so what's left is the actual program description.
const WOW_BOILERPLATE = [
  "The Museum is available for private playtime and private party rentals. Contact us for availability and options!",
  "Support the Museum by purchasing an annual family membership. Memberships include unlimited admission for a year and other great benefits!",
  "Make a donation!",
  "If the registration link is inactive, that means our event is at full capacity and we cannot accept new registrations."
];

// Fetches one WOW event's detail page and extracts its real description,
// stripping the sidebar boilerplate above and de-duping the description
// text (WOW's template renders it twice on most detail pages).
async function fetchWowEventDescription(url) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "PlayrouteBot/1.0 (+https://playroute.app)" } });
    if (!res.ok) return null;
    const html = await res.text();
    let text = decodeHtmlEntities(
      stripTags(html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " "))
    );
    for (const bp of WOW_BOILERPLATE) text = text.split(bp).join(" ");
    const sentences = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
    const seen = new Set();
    const unique = sentences.filter((s) => {
      const key = s.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const desc = unique.join(" ").trim();
    return desc.length > 20 ? truncateAtBoundary(desc, 400) : null;
  } catch {
    // A single event's description fetch failing shouldn't break the whole
    // scrape run — the caller falls back to the generic placeholder note.
    return null;
  }
}

async function parseWowCalendarHtml(html, city) {
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

    const sourceUrl = href.startsWith("http") ? href : `https://wowchildrensmuseum.org${href}`;
    const realDescription = allDay ? null : await fetchWowEventDescription(sourceUrl);

    events.push({
      title,
      source: `${city} \u2014 WOW! Children's Museum`,
      city,
      category: "museum",
      cost: isPaid ? "paid" : "free",
      age_min,
      age_max,
      // FIX (2026-07-14): this was `undefined`, which crashed at approval
      // time with "NOT NULL constraint failed: events.day_of_week" — the
      // real table requires day_of_week on every row, even dated ones (used
      // for display, e.g. "Saturday, July 11"). Anchored at noon UTC, same
      // safe pattern used elsewhere in this file, since eventDate here is
      // already the museum's own local calendar date, not a UTC instant
      // needing conversion.
      day_of_week: DAY_NAMES[new Date(`${eventDate}T12:00:00Z`).getUTCDay()],
      start_time: finalStartTime,
      display_time: displayTime,
      recurrence: "dated",
      event_date: eventDate,
      note: allDay
        ? "Multi-day program \u2014 check the museum's event page for the full daily schedule."
        : (realDescription || "Pulled from WOW! Children's Museum's public calendar."),
      source_url: sourceUrl,
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
    allEvents.push(...(await parseWowCalendarHtml(html, WOW_MUSEUM.city)));
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

// Registered below (after SOURCE_RUNNERS import target exists) as the
// wow_museum runner — just returns candidates, ingestCandidate handles the rest.
SOURCE_RUNNERS.wow_museum = async () => fetchAndNormalizeWowCalendar();

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
        note: truncateAtBoundary(plainBody, 300),
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
      note: truncateAtBoundary(plainBody, 300),
      source_url: `https://www.townofmead.org${item.link}`,
      verified: 0, // auto-parsed from prose — flagged unverified, unlike hand-curated entries
      libcal_event_id: `mead:${item.id}`,
      _assumedTime: !parsed.startTime // true when no real time was found and we fell back to 9am
    });
  }
  return { events, needsReview };
}

// Both halves — confidently-parsed single-date events AND the
// couldn't-parse-confidently "needs review" items — now flow through the
// same pending_events path (per your instruction: everything automated
// goes to review for now). The needsReview items are missing several
// required fields on purpose (category/cost/age/time were never guessed at)
// so validateCandidate will correctly flag them as needing your attention
// rather than silently showing up looking complete.
SOURCE_RUNNERS.mead_json = async () => {
  const { events, needsReview } = await fetchAndNormalizeMeadCalendar();
  return [...events, ...needsReview];
};

// --- Westminster Public Library scraper (pending-review only) ---
// Source: https://westminsterco.librarycalendar.com
//
// Different platform than Boulder/Erie (Ruby-based iCalendar generation,
// confirmed via a manual .ics export showing PRODID:iCalendar-Ruby) and no
// confirmed iCal subscribe endpoint, so this scrapes the public HTML
// directly — plain fetch(), no browser rendering, since detail pages here
// are server-rendered (confirmed by reading real page text).
//
// UNVERIFIED, on purpose: exact date/time markup and whether specific ages
// ever appear in free text vs. only broad audience tags. Rather than guess
// and risk silently inserting wrong dates/times into the live events table,
// everything found here lands in pending_events for you to review and
// approve/reject via the existing email flow — same as the Mead "needs
// review" path. Once you've approved a few and are confident the parsing
// is solid, this is a reasonable candidate to promote to auto-add later.
const WESTMINSTER_LIBRARY_LIST_URL = "https://westminsterco.librarycalendar.com/events/upcoming";
const WESTMINSTER_LIBRARY_BASE_URL = "https://westminsterco.librarycalendar.com";

// Matches href="/event/<slug>-<id>" links in the list page's raw HTML.
const WESTMINSTER_EVENT_LINK_RE = /href="(\/event\/[\w-]+)"/gi;

function extractWestminsterEventPaths(html) {
  const paths = new Set();
  let m;
  while ((m = WESTMINSTER_EVENT_LINK_RE.exec(html)) !== null) {
    paths.add(m[1]);
  }
  return [...paths];
}

/**
 * Parses a Westminster library event detail page from raw HTML text.
 * Confirmed against real page text (via search-engine snippets, not a
 * live render): location renders as "Branch · Street Address · City, ST
 * ZIP", and category/audience tags appear as a plain comma-separated line
 * before the description. Date/time markup is NOT confirmed — the regexes
 * below are placeholders. Check raw_excerpt in the pending-review email
 * against what's actually there before trusting this beyond manual review.
 */
function parseWestminsterLibraryDetail(html, url) {
  const noScript = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  const text = decodeHtmlEntities(stripTags(noScript));

  const titleMatch = html.match(/<h1[^>]*>(.*?)<\/h1>/is);
  const title = titleMatch ? decodeHtmlEntities(stripTags(titleMatch[1])).trim() : null;
  const cancelled = /^CANCELLED/i.test(title || "");

  const locationMatch = text.match(
    /([\w\s]+?)\s*[·•]\s*(\d+[\w\s.]+?)\s*[·•]\s*(Westminster,\s*CO\s*\d{5})/i
  );

  const categoryAudienceMatch = text.match(
    /([\w\s&,]+?)\s*[·•]\s*(Adults|Teens|Youth|Children|All Ages|Birth[\w\s-]*)/i
  );
  const categories = categoryAudienceMatch ? categoryAudienceMatch[1].trim() : null;
  const audience = categoryAudienceMatch ? categoryAudienceMatch[2].trim() : null;

  // UNVERIFIED placeholders — replace once you've seen a real detail page.
  const dateMatch = text.match(/(\w+day),?\s+([A-Za-z]+\.?\s+\d{1,2}\.?,?\s+\d{4})/i);
  const timeMatch = text.match(/(\d{1,2}:\d{2}\s*[ap]m)\s*[-–]\s*(\d{1,2}:\d{2}\s*[ap]m)/i);

  return {
    title,
    cancelled,
    source_url: url,
    raw_day: dateMatch ? dateMatch[1] : null,
    raw_date: dateMatch ? dateMatch[2] : null,
    raw_start: timeMatch ? timeMatch[1] : null,
    raw_end: timeMatch ? timeMatch[2] : null,
    location: locationMatch
      ? `${locationMatch[1].trim()} — ${locationMatch[2].trim()}, ${locationMatch[3].trim()}`
      : null,
    audience,
    categories,
    raw_excerpt: truncateAtBoundary(text, 400)
  };
}

function ageFromWestminsterLibraryText(audience) {
  const a = (audience || "").toLowerCase();
  if (a.includes("birth")) return { age_min: 0, age_max: 5 };
  if (a.includes("youth") || a.includes("children")) return { age_min: 5, age_max: 12 };
  if (a.includes("teen")) return { age_min: 12, age_max: 18 };
  if (a.includes("all ages")) return { age_min: 0, age_max: 18 };
  return null; // covers "adults" and anything unrecognized — not a kid event
}

async function fetchAndScanWestminsterLibrary() {
  const needsReview = [];
  const listRes = await fetch(WESTMINSTER_LIBRARY_LIST_URL, {
    headers: { "User-Agent": "PlayrouteBot/1.0 (+https://playroute.co)" }
  });
  if (!listRes.ok) throw new Error(`Westminster library list fetch failed: ${listRes.status}`);
  const listHtml = await listRes.text();
  const paths = extractWestminsterEventPaths(listHtml);

  for (const path of paths) {
    const detailUrl = `${WESTMINSTER_LIBRARY_BASE_URL}${path}`;
    const res = await fetch(detailUrl, {
      headers: { "User-Agent": "PlayrouteBot/1.0 (+https://playroute.co)" }
    });
    if (!res.ok) continue;
    const html = await res.text();
    const detail = parseWestminsterLibraryDetail(html, detailUrl);
    if (!detail.title || detail.cancelled) continue;

    const ages = ageFromWestminsterLibraryText(detail.audience);
    if (!ages) continue; // adult-only program — not relevant to Playroute

    needsReview.push({
      title: detail.title,
      source: `Westminster Public Library${detail.location ? " — " + detail.location : ""}`,
      city: "Westminster",
      category: "library",
      cost: "free",
      age_min: ages.age_min,
      age_max: ages.age_max,
      day_of_week: detail.raw_day,
      start_time: null, // unverified extraction — leave for the reviewer to fill in on approval
      display_time: detail.raw_start
        ? detail.raw_end
          ? `${detail.raw_start} – ${detail.raw_end}`
          : detail.raw_start
        : "Check listing for time",
      recurrence: "weekly",
      note: detail.categories
        ? `Category: ${detail.categories}. ${detail.raw_excerpt}`
        : detail.raw_excerpt,
      source_url: detailUrl
      // No dedup_key here on purpose — this platform mints a new URL per
      // date instance of a recurring program (confirmed bug, 2026-07-14),
      // so keying on `path` meant the same weekly program got queued as a
      // "new" candidate every week. Letting the pipeline compute a stable
      // title+city+day key instead is the actual fix.
    });
  }
  return needsReview;
}

SOURCE_RUNNERS.westminster_library = async () => fetchAndScanWestminsterLibrary();

// --- Lyons Regional Library scraper (list-page only, weekly) ---------------
// Source: https://lyons.librarycalendar.com/events/upcoming -- same "Library
// Market" vendor platform as Westminster above (see the dedup-key comment
// in pipeline.js re: this vendor minting a new URL per date instance of a
// recurring program). Deliberately does NOT fetch individual /event/<slug>
// detail pages the way the Westminster scraper does: confirmed by testing a
// real fetch that this site's robots.txt disallows automated access to
// /event/ paths specifically, even though /events/upcoming itself is
// allowed. Conveniently, the upcoming-events list page already renders each
// event's full detail inline (branch, room, age group, program type,
// description), so a single list-page fetch covers everything -- no detail
// page fetch needed, and no robots.txt violation either.
//
// UNVERIFIED like the Westminster scraper: regexes below are built from
// visible page text (via search-engine snippets), not a confirmed live
// render of the raw HTML tag structure -- this vendor's markup wasn't
// directly inspectable. confidence is set to 'review' in scrape_sources on
// purpose: treat every queued item as needing a look before approving,
// same as Westminster.
const LYONS_LIBRARY_LIST_URL = "https://lyons.librarycalendar.com/events/upcoming";
const LYONS_LIBRARY_BASE_URL = "https://lyons.librarycalendar.com";

// Non-library-sponsored meeting-room bookings (town commissions, blood
// drives) show up in the same feed as real library programs, each flagged
// inline with this literal text -- filtered out since they're not family
// activity content.
const LYONS_NOT_SPONSORED_RE = /This is not a library sponsored event\./i;

function ageFromLyonsGroups(ageGroupText) {
  const g = (ageGroupText || "").toLowerCase();
  const groups = g.split(",").map((s) => s.trim()).filter(Boolean);
  if (groups.length === 0 || groups.every((x) => x === "adults")) return null; // adults-only -- not Playroute content
  let min = null, max = null;
  const widen = (lo, hi) => {
    if (min === null || lo < min) min = lo;
    if (max === null || hi > max) max = hi;
  };
  if (groups.includes("babies")) widen(0, 2);
  if (groups.includes("children")) widen(3, 8);
  if (groups.includes("tweens")) widen(8, 12);
  if (groups.includes("teens")) widen(12, 18);
  if (min === null) return null; // nothing recognized
  return { age_min: min, age_max: max };
}

function parseLyonsEventBlock(blockText, href) {
  // Example raw text shape (confirmed via search-engine snippet, not a
  // live render): 'Feb 24 2026 Tue Baby Storytime 10:30am–11:00am ...
  // Library Branch: Lyons Community Library Room: Community Room
  // Age Group: Babies Program Type: Storytime Event Details: <description>'
  const dateMatch = blockText.match(
    /([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{4})\s+\w{3}\s+(.+?)\s+(\d{1,2}:\d{2}[ap]m)\s*[–-]\s*(\d{1,2}:\d{2}[ap]m)/i
  );
  if (!dateMatch) return null;
  const [, monAbbr, day, year, title, startLabel, endLabel] = dateMatch;
  const monthIdx = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"].indexOf(monAbbr);
  if (monthIdx === -1) return null;
  const eventDate = `${year}-${String(monthIdx + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

  const roomMatch = blockText.match(/Room:\s*(.+?)(?:\s+Age Group:|\s+Purpose of Meeting|\s+Event Details:|$)/i);
  const ageGroupMatch = blockText.match(/Age Group:\s*(.+?)(?:\s+Program Type:|\s+Event Details:|\s+Registration|$)/i);
  const detailsMatch = blockText.match(/Event Details:\s*(.+)$/i);

  return {
    title: decodeHtmlEntities(title).trim(),
    eventDate,
    startLabel,
    endLabel,
    room: roomMatch ? decodeHtmlEntities(roomMatch[1]).trim() : null,
    ageGroup: ageGroupMatch ? ageGroupMatch[1].trim() : null,
    details: detailsMatch ? truncateAtBoundary(decodeHtmlEntities(detailsMatch[1]).trim(), 400) : null,
    notSponsored: LYONS_NOT_SPONSORED_RE.test(blockText),
    href
  };
}

async function fetchAndScanLyonsLibrary() {
  const needsReview = [];
  const res = await fetch(LYONS_LIBRARY_LIST_URL, {
    headers: { "User-Agent": "PlayrouteBot/1.0 (+https://playroute.co)" }
  });
  if (!res.ok) throw new Error(`Lyons library list fetch failed: ${res.status}`);
  const html = await res.text();
  const noScript = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");

  // Each event card links to its own /event/<slug> detail page -- the href
  // is used purely to build a human-facing source_url, NOT fetched (see
  // robots.txt note above). Split the page into per-event chunks using
  // each href as a boundary, then parse the plain-text version of each
  // chunk. This vendor commonly renders two DOM copies of the same event
  // (compact card + expanded detail) back-to-back -- dedup below keeps
  // only one candidate per title+date+time.
  const hrefPositions = [];
  let m;
  const hrefOnlyRe = /href="(\/event\/[\w-]+)"/gi;
  while ((m = hrefOnlyRe.exec(noScript)) !== null) {
    hrefPositions.push({ href: m[1], index: m.index });
  }

  const seen = new Set();
  for (let i = 0; i < hrefPositions.length; i++) {
    const start = hrefPositions[i].index;
    const end = i + 1 < hrefPositions.length ? hrefPositions[i + 1].index : start + 3000;
    const chunkText = decodeHtmlEntities(stripTags(noScript.slice(start, end))).replace(/\s+/g, " ").trim();

    const parsed = parseLyonsEventBlock(chunkText, hrefPositions[i].href);
    if (!parsed || parsed.notSponsored) continue;

    const dedupSig = `${parsed.title}|${parsed.eventDate}|${parsed.startLabel}`;
    if (seen.has(dedupSig)) continue;
    seen.add(dedupSig);

    const ages = ageFromLyonsGroups(parsed.ageGroup);
    if (!ages) continue; // adults-only or unrecognized -- not Playroute content

    const startTime = to24HourFromLabel(parsed.startLabel);
    const d = new Date(`${parsed.eventDate}T12:00:00Z`);
    const dayOfWeek = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][d.getUTCDay()];

    needsReview.push({
      title: parsed.title,
      source: `Lyons Regional Library${parsed.room ? " — " + parsed.room : ""}`,
      city: "Lyons",
      category: "library",
      cost: "free",
      age_min: ages.age_min,
      age_max: ages.age_max,
      day_of_week: dayOfWeek,
      start_time: startTime,
      display_time: `${parsed.startLabel}–${parsed.endLabel}`,
      recurrence: "dated",
      event_date: parsed.eventDate,
      note: parsed.details || null,
      source_url: `${LYONS_LIBRARY_BASE_URL}${parsed.href}`
    });
  }
  return needsReview;
}

SOURCE_RUNNERS.lyons_library = async () => fetchAndScanLyonsLibrary();

// --- Jefferson County Public Library, Arvada Balsam branch (BiblioCommons) -
// Source: https://jeffcolibrary.bibliocommons.com/v2/events?locations=ARBA
// A different platform than the "Library Market" family above --
// BiblioCommons, used by 200+ library systems. IMPORTANT SCOPE NOTE: the
// original URL Holly supplied filtered by kid audience only, with no
// location filter -- that returns the ENTIRE Jefferson County system
// (5,257 events across 17 branches, most nowhere near Boulder County:
// Golden, Lakewood, Littleton, Evergreen, Conifer, etc). Scoped down here
// to just the Arvada Balsam Temporary Library (the current stand-in while
// the main Arvada branch is closed for a redesign) via ?locations=ARBA.
// Tried combining that with the original audience filter too, but the
// comma-separated audiences param didn't combine reliably with locations
// in testing -- so audience filtering happens client-side below instead
// (checking each event's own audience tags), which is more robust anyway
// since it doesn't depend on unverified query-param encoding.
//
// UNVERIFIED like the other scraper-type sources: BiblioCommons' actual
// HTML tag structure wasn't directly inspectable, so the regexes below are
// built from visible page text patterns. confidence is set to 'review' on
// purpose -- treat every queued item as needing a look before approving.
const JCPL_ARVADA_LIST_URL = "https://jeffcolibrary.bibliocommons.com/v2/events?locations=ARBA";
const JCPL_ARVADA_MAX_PAGES = 6; // ~6 weeks of coverage at this branch's pace

function ageFromJcplAudiences(audienceTags) {
  const tags = audienceTags.map((t) => t.toLowerCase());
  let min = null, max = null;
  const widen = (lo, hi) => {
    if (min === null || lo < min) min = lo;
    if (max === null || hi > max) max = hi;
  };
  if (tags.includes("babies")) widen(0, 2);
  if (tags.includes("toddlers")) widen(1, 3);
  if (tags.includes("preschoolers")) widen(3, 5);
  if (min === null) return null; // no baby/toddler/preschooler tag -- not in scope
  return { age_min: min, age_max: max };
}

function parseJcplEventChunk(rawChunk, permalink) {
  // decodeHtmlEntities(stripTags()) first, so this all operates on plain
  // text regardless of the real surrounding markup -- same technique used
  // for the Lyons scraper above, chosen because the exact tag structure
  // here is unverified.
  const text = decodeHtmlEntities(stripTags(rawChunk)).replace(/\s+/g, " ").trim();
  if (/\bCanceled\b/.test(rawChunk.slice(0, 200))) return null; // skip canceled sessions

  const dateMatch = text.match(/on ([A-Z][a-z]+ \d{1,2}, \d{4}), (\d{1,2}:\d{2}[ap]m)[\u2013-]+(\d{1,2}:\d{2}[ap]m)/);
  if (!dateMatch) return null;
  const [, dateStr, startLabel, endLabel] = dateMatch;
  const d = new Date(dateStr + " 12:00:00");
  if (isNaN(d.getTime())) return null;
  const eventDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const dayOfWeek = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][d.getDay()];

  // Title comes from the actual anchor text on the real HTML (most
  // reliable single signal available), not the plain-text chunk -- the
  // first /v2/events/<id> anchor in a chunk is consistently the title link
  // in every real page fetched during development.
  const titleMatch = rawChunk.match(/<a[^>]+href="\/v2\/events\/[0-9a-f]+"[^>]*>([^<]+)<\/a>/i);
  if (!titleMatch) return null;
  const title = decodeHtmlEntities(titleMatch[1]).trim();

  const locationMatch = text.match(/Event location:\s*([A-Za-z0-9 .'&()-]{3,60})/);
  const location = locationMatch ? locationMatch[1].trim() : "Arvada Balsam Temporary Library";

  // Audience tags appear as repeated "<Name>Find more events in: <Name>"
  // link text -- capture the leading name before that literal suffix.
  const audienceTags = [];
  const audRe = /([A-Za-z ]+?)Find more events in: \1/g;
  let m;
  while ((m = audRe.exec(text)) !== null) audienceTags.push(m[1].trim());
  const ages = ageFromJcplAudiences(audienceTags);
  if (!ages) return null; // not a baby/toddler/preschooler event -- skip

  // Description: between the location label and the first audience-tag
  // sentence, truncated -- BiblioCommons itself truncates with "…" mid
  // sentence in the source text, which is fine for a pending-review note.
  const descMatch = text.match(/Event location:\s*[A-Za-z0-9 .'&()-]{3,60}\s*(.+?)(?:Story TimesFind|BabiesFind|ToddlersFind|PreschoolersFind|$)/);
  const description = descMatch ? descMatch[1].trim().slice(0, 350) : null;

  return {
    title,
    source: `Jefferson County Public Library \u2014 ${location}`,
    city: "Arvada",
    category: "library",
    cost: "free",
    age_min: ages.age_min,
    age_max: ages.age_max,
    day_of_week: dayOfWeek,
    start_time: to24HourFromLabel(startLabel),
    display_time: `${startLabel}\u2013${endLabel}`,
    recurrence: "dated",
    event_date: eventDate,
    note: description,
    source_url: `https://jeffcolibrary.bibliocommons.com${permalink}`
  };
}

async function fetchAndScanJcplArvada() {
  const needsReview = [];
  const seen = new Set();
  for (let page = 1; page <= JCPL_ARVADA_MAX_PAGES; page++) {
    const url = page === 1 ? JCPL_ARVADA_LIST_URL : `${JCPL_ARVADA_LIST_URL}&page=${page}`;
    const res = await fetch(url, { headers: { "User-Agent": "PlayrouteBot/1.0 (+https://playroute.co)" } });
    if (!res.ok) break;
    const html = await res.text();
    const noScript = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");

    const hrefPositions = [];
    let m;
    const hrefOnlyRe = /href="(\/v2\/events\/[0-9a-f]+)"/gi;
    while ((m = hrefOnlyRe.exec(noScript)) !== null) hrefPositions.push({ href: m[1], index: m.index });
    if (hrefPositions.length === 0) break; // no more events -- stop paging

    for (let i = 0; i < hrefPositions.length; i++) {
      const start = hrefPositions[i].index;
      const end = i + 1 < hrefPositions.length ? hrefPositions[i + 1].index : start + 3000;
      const chunkHtml = noScript.slice(start, end);
      const parsed = parseJcplEventChunk(chunkHtml, hrefPositions[i].href);
      if (!parsed) continue;
      const dedupSig = `${parsed.title}|${parsed.event_date}|${parsed.start_time}`;
      if (seen.has(dedupSig)) continue;
      seen.add(dedupSig);
      needsReview.push(parsed);
    }
  }
  return needsReview;
}

SOURCE_RUNNERS.jcpl_arvada = async () => fetchAndScanJcplArvada();

// --- Longmont Public Library (WordPress "Events Calendar"-family plugin) --
// Source: https://longmontcolorado.gov/events/category/library/
// Verified for real via a live fetch (2026-07-27): this genuinely is
// WordPress (wp-content/uploads paths on every event image), confirming
// the platform note that was already on this scrape_sources row. A
// separate claim on the same row -- that a "longmont-scrape" job had
// already shipped -- was false and was already corrected by a prior
// session; this is the actual first real implementation.
//
// Dated "Series" instances (recurring programs like Baby Storytime,
// Toddler Stay & Play) get a permalink with the specific date baked in:
// /event/{slug}/{YYYY-MM-DD}/. One-time specials instead get a bare
// /event/{slug}/ with no date segment. Only the dated kind are scraped
// here -- deliberately mirrors the original manual-review notes' own
// stated strategy ("only known recurring child/family program titles are
// auto-added; one-off specials still need manual review"), and it means
// event_date comes straight from the URL itself rather than being parsed
// out of display text, which is the most reliable field available.
//
// No structured age-group field exists on this platform (unlike JCPL's
// BiblioCommons), so kid-relevance is inferred from title text: a
// denylist catches clearly adult-only content (conversation groups, adult
// book/writers groups, closures), anything else that survives is treated
// as family content, matching the "nothing auto-publishes" safety net.
// UNVERIFIED against the real HTML tag structure, same as the other
// scraper-type sources -- confidence set to 'review' on purpose.
const LONGMONT_LIBRARY_LIST_URL = "https://longmontcolorado.gov/events/category/library/";
const LONGMONT_LIBRARY_MAX_PAGES = 6;
const LONGMONT_ADULT_DENYLIST_RE = /adult|senior center|writers group|book group|conversation group|library closed|current events meeting|resume|job (search|club)|tax help/i;

function ageFromLongmontTitle(title) {
  const t = title.toLowerCase();
  if (/\bbaby\b/.test(t)) return { age_min: 0, age_max: 2 };
  if (/\btoddler\b/.test(t)) return { age_min: 1, age_max: 3 };
  if (/\bpreschool/.test(t)) return { age_min: 3, age_max: 5 };
  if (/\btween/.test(t)) return { age_min: 8, age_max: 12 };
  if (/\bteen/.test(t)) return { age_min: 12, age_max: 18 };
  if (/\bkids?\b|\bkid club\b/.test(t)) return { age_min: 5, age_max: 10 };
  return { age_min: 0, age_max: 18 }; // "all ages", "family", or unlabeled -- broad default, gated by review
}

function parseLongmontEventChunk(rawChunk, permalink, eventDate) {
  const text = decodeHtmlEntities(stripTags(rawChunk)).replace(/\s+/g, " ").trim();
  if (LONGMONT_ADULT_DENYLIST_RE.test(text)) return null;

  const titleMatch = rawChunk.match(/<a[^>]+href="[^"]*\/event\/[^"]+"[^>]*>([^<]+)<\/a>/i);
  if (!titleMatch) return null;
  const title = decodeHtmlEntities(titleMatch[1]).trim();
  if (LONGMONT_ADULT_DENYLIST_RE.test(title)) return null;

  const timeMatch = text.match(/(\d{1,2}(?::\d{2})?\s*[ap]m)\s*[-\u2013\u2014]\s*(\d{1,2}(?::\d{2})?\s*[ap]m)/i);
  if (!timeMatch) return null; // no time range -- likely a multi-day banner (e.g. Summer Reading), skip
  const [, startLabel, endLabel] = timeMatch;

  // Everything after the matched time range, in order: an optional
  // "<Series Name> Series" label, an optional location line, then the
  // description. Sliced by position rather than chained regex matches --
  // an earlier version re-matched "pm" and grabbed the wrong occurrence
  // when a title had two time labels, and the address regex broke on the
  // literal period in "355 Emery St.,".
  let tail = text.slice(timeMatch.index + timeMatch[0].length).trim();
  tail = tail.replace(/^.*?\bSeries\b\s*/, "");

  const locationMatch = tail.match(/^Longmont Public Library\s+\d+.*?(?:CO|Colorado)(?:,\s*United States)?/);
  let location = "Longmont Public Library";
  if (locationMatch) {
    location = locationMatch[0].trim();
    tail = tail.slice(locationMatch[0].length).trim();
  }
  const description = tail ? tail.slice(0, 350) : null;

  const d = new Date(eventDate + "T12:00:00Z");
  const dayOfWeek = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][d.getUTCDay()];
  const ages = ageFromLongmontTitle(title);

  return {
    title,
    source: location,
    city: "Longmont",
    category: "library",
    cost: "free",
    age_min: ages.age_min,
    age_max: ages.age_max,
    day_of_week: dayOfWeek,
    start_time: to24HourFromLabel(startLabel.replace(/^(\d{1,2})\s*([ap]m)$/i, "$1:00$2")),
    display_time: `${startLabel} - ${endLabel}`,
    recurrence: "dated",
    event_date: eventDate,
    note: description,
    source_url: `https://longmontcolorado.gov${permalink}`
  };
}

async function fetchAndScanLongmontLibrary() {
  const needsReview = [];
  const seen = new Set();
  for (let page = 1; page <= LONGMONT_LIBRARY_MAX_PAGES; page++) {
    const url = page === 1 ? LONGMONT_LIBRARY_LIST_URL : `${LONGMONT_LIBRARY_LIST_URL}page/${page}/`;
    const res = await fetch(url, { headers: { "User-Agent": "PlayrouteBot/1.0 (+https://playroute.co)" } });
    if (!res.ok) break;
    const html = await res.text();
    const noScript = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");

    const hrefPositions = [];
    let m;
    const hrefOnlyRe = /href="(https?:\/\/longmontcolorado\.gov\/event\/[\w-]+\/(\d{4}-\d{2}-\d{2})\/)"/gi;
    while ((m = hrefOnlyRe.exec(noScript)) !== null) {
      const path = m[1].replace(/^https?:\/\/longmontcolorado\.gov/, "");
      hrefPositions.push({ href: path, eventDate: m[2], index: m.index });
    }
    if (hrefPositions.length === 0) break;

    for (let i = 0; i < hrefPositions.length; i++) {
      const start = hrefPositions[i].index;
      const end = i + 1 < hrefPositions.length ? hrefPositions[i + 1].index : start + 2500;
      const chunkHtml = noScript.slice(start, end);
      const parsed = parseLongmontEventChunk(chunkHtml, hrefPositions[i].href, hrefPositions[i].eventDate);
      if (!parsed) continue;
      const dedupSig = `${parsed.title}|${parsed.event_date}|${parsed.start_time}`;
      if (seen.has(dedupSig)) continue;
      seen.add(dedupSig);
      needsReview.push(parsed);
    }
  }
  return needsReview;
}

SOURCE_RUNNERS.longmont_library = async () => fetchAndScanLongmontLibrary();

// --- Anythink Thornton Community Center (Communico v2 XML export feed) --
// Source: https://api.communico.co/v2/anythinklibraries/events/export.xml
//   ?locations=Anythink+Thornton+Community+Center
//
// Genuinely more reliable than most other scrapers here: this is a real,
// documented XML export (not scraped HTML), and it already gives weekday,
// start/end time, and location as clean separate fields -- no chunk-
// boundary guessing, no regex against raw markup. Verified against real
// sample output before writing this (a live "Chair Yoga with Bo for
// Seniors" entry), not just the generic docs example.
//
// One real data-quality gotcha found in that same sample: the structured
// StartTime/EndTime fields for a specific date CAN disagree with what the
// event's own LongDescription prose says for that date (an 8:00-8:30am
// entry whose description text said "10-10:30 a.m." for that exact date).
// Trusting the structured fields as the source of truth here rather than
// trying to parse prose overrides -- too fragile, and the structured
// fields are what a human would see first anyway. Flagged with
// confidence='review' like every other scraper, so this is caught by a
// human either way, not silently trusted.
const ANYTHINK_THORNTON_URL = "https://api.communico.co/v2/anythinklibraries/events/export.xml?locations=Anythink+Thornton+Community+Center";
// Ages tags that mean "not for kids" on their own -- an event tagged
// ONLY with these (no kid/family tag alongside) gets skipped. Matches the
// denylist-over-allowlist approach used for other sources with no
// structured age field; this one DOES have a structured field, so this is
// simpler and more reliable than most.
const ANYTHINK_ADULT_ONLY_AGES = new Set(["adults", "seniors"]);
const ANYTHINK_AGE_RANGES = {
  babies: [0, 1], toddlers: [1, 3], children: [3, 10], elementary: [5, 11],
  tweens: [9, 13], teens: [13, 18], families: [0, 18]
};

function parseAnythinkAges(agesRaw) {
  const tags = agesRaw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (tags.length === 0) return null; // no age info at all -- can't safely classify, skip
  const hasKidTag = tags.some((t) => !ANYTHINK_ADULT_ONLY_AGES.has(t));
  if (!hasKidTag) return null; // adults/seniors only -- not for this app
  // "families" is a modifier ("appropriate to attend together"), not a
  // real age constraint -- a real bug caught in testing: "Toddlers,
  // Families" was collapsing to a blanket 0-18 because Families' own
  // 0-18 range swamped Toddlers' much more specific 1-3 in a plain
  // min/max merge. Only fall back to it if nothing more specific exists.
  const specificTags = tags.filter((t) => t !== "families" && ANYTHINK_AGE_RANGES[t]);
  const tagsToUse = specificTags.length > 0 ? specificTags : tags;
  let min = 18, max = 0;
  for (const t of tagsToUse) {
    const range = ANYTHINK_AGE_RANGES[t];
    if (!range) continue;
    min = Math.min(min, range[0]);
    max = Math.max(max, range[1]);
  }
  if (max === 0) return { age_min: 0, age_max: 18 }; // had a kid-relevant tag but not one we mapped -- default broad
  return { age_min: min, age_max: max };
}

// The feed's <Date> field is like "Aug 21" with no year. Infer the year:
// if that month/day has already passed this year (more than ~2 months
// ago, to tolerate the feed listing a few recent-past events), assume
// it's next year -- handles the Dec/Jan rollover without needing the feed
// to ever say a plain year.
function resolveAnythinkYear(monthDayStr, now) {
  const thisYear = now.getFullYear();
  const guess = new Date(`${monthDayStr} ${thisYear} 12:00:00`);
  if (isNaN(guess.getTime())) return null;
  const daysDiff = (guess - now) / 86400000;
  if (daysDiff < -60) return thisYear + 1;
  return thisYear;
}

function to24HourAnythink(label) {
  const m = label.trim().match(/(\d{1,2}):(\d{2})\s*([ap])m/i);
  if (!m) return null;
  let [, h, min, ap] = m;
  h = +h;
  if (ap.toLowerCase() === "p" && h !== 12) h += 12;
  if (ap.toLowerCase() === "a" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${min}`;
}

async function fetchAndScanAnythinkThornton() {
  const res = await fetch(ANYTHINK_THORNTON_URL, {
    headers: { "User-Agent": "PlayrouteBot/1.0 (+https://playroute.co)" }
  });
  if (!res.ok) throw new Error(`Anythink Thornton feed returned ${res.status}`);
  const xml = await res.text();
  const now = new Date();

  const candidates = [];
  const eventBlockRe = /<event>([\s\S]*?)<\/event>/g;
  const seen = new Set();
  let m;
  while ((m = eventBlockRe.exec(xml)) !== null) {
    const block = m[1];
    const field = (tag) => {
      const fm = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
      return fm ? decodeHtmlEntities(fm[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1")).trim() : "";
    };

    const agesRaw = field("Ages");
    const ages = parseAnythinkAges(agesRaw);
    if (!ages) continue; // adults/seniors-only or unparseable -- skip, not for this app

    const title = field("Title");
    if (!title) continue;
    const monthDay = field("Date"); // e.g. "Aug 21"
    const weekday = field("Weekday");
    const startLabel = field("StartTime");
    const endLabel = field("EndTime");
    const location = field("Location");
    const shortDesc = field("ShortDescription");
    const startTime = to24HourAnythink(startLabel);
    if (!startTime || !monthDay || !weekday) continue; // can't build a usable event without these

    const year = resolveAnythinkYear(monthDay, now);
    if (!year) continue;
    const eventDate = new Date(`${monthDay} ${year} 12:00:00`).toISOString().slice(0, 10);

    const dedupSig = `${title}|${eventDate}|${startTime}|${location}`;
    if (seen.has(dedupSig)) continue;
    seen.add(dedupSig);

    candidates.push({
      title,
      source: /^anythink/i.test(location) ? location : `Anythink ${location || "Thornton Community Center"}`,
      city: "Thornton",
      category: "library",
      cost: "free",
      age_min: ages.age_min,
      age_max: ages.age_max,
      day_of_week: weekday,
      start_time: startTime,
      display_time: endLabel ? `${startLabel} - ${endLabel}` : startLabel,
      recurrence: "dated",
      event_date: eventDate,
      note: shortDesc ? shortDesc.slice(0, 350) : null,
      source_url: "https://events.anythinklibraries.org/events?l=Anythink+Thornton+Community+Center"
    });
  }
  return candidates;
}

SOURCE_RUNNERS.anythink_thornton = async () => fetchAndScanAnythinkThornton();

// --- My Nature Lab (Louisville) Story Time scraper (pending-review only) ---
// Source: https://www.mynaturelab.org/story-time -- a Wix site. Confirmed
// server-rendered (a plain fetch returns the actual dated listings, not an
// empty JS shell), so no headless browser needed. Runs MONTHLY, not daily
// (see wrangler.jsonc cron + scheduled() branch below) -- the page only ever
// lists ~4 upcoming weeks of topics at a time, so a monthly check is enough
// to catch each new batch as it's posted.
//
// IMPORTANT -- selectors below are a best-effort guess against the *rendered
// text* of the page (via a markdown-style fetch), not the actual raw HTML,
// which this environment couldn't access directly. The site's own copy is
// also internally inconsistent -- meta tags and one paragraph say
// "Wednesdays and Sundays", but the big on-page header and every single
// dated listing pair Sunday with Thursday. This scraper trusts the dated
// listings (Sunday + Thursday) since that's the pattern actually backed by
// real per-topic dates, not the prose. Given the raw-HTML gap, this source
// is registered with confidence='review' in scrape_sources, so every
// candidate it produces gets a validation warning regardless of how clean
// it looks -- don't flip that to 'trusted' without confirming the regex
// against a real page fetch first (log _rawTextSample the way the Boulder
// scraper does).
const MY_NATURE_LAB_URL = "https://www.mynaturelab.org/story-time";
const MY_NATURE_LAB_MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December";

function stripHtmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Matches: "<Title> ... Sunday, <Month> <Day> and Thursday, <Month> <Day>
// ... Story: <Book> by <Author> ... Animal Encounter: <Animal>" blocks,
// repeated down the page. Title capture is greedy-limited and best-effort --
// this is the part most likely to need adjusting against real HTML, since
// heading tags don't survive stripHtmlToText the same way they did in the
// markdown-style fetch this was drafted against.
const MY_NATURE_LAB_BLOCK_RE = new RegExp(
  `([A-Z][A-Za-z0-9:'!,.\\- ]{2,60}?)\\s*` +
  `Sunday,\\s*(${MY_NATURE_LAB_MONTHS})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s+and\\s+Thursday,\\s*(${MY_NATURE_LAB_MONTHS})?\\s*(\\d{1,2})(?:st|nd|rd|th)?\\s*` +
  `Story:\\s*(.+?)\\s+by\\s+(.+?)\\s*` +
  `Animal Encounter:\\s*(.+?)(?=\\s[A-Z][A-Za-z0-9:'!,.\\- ]{2,60}?\\s*Sunday,|$)`,
  "gi"
);

function nextDateForMonthDay(monthName, day, now) {
  const monthIdx = MY_NATURE_LAB_MONTHS.split("|").findIndex(m => m.toLowerCase() === monthName.toLowerCase());
  if (monthIdx < 0) return null;
  let year = now.getFullYear();
  let d = new Date(year, monthIdx, +day);
  // If that date already passed by more than a week, assume it's next year's occurrence.
  if (d < new Date(now.getTime() - 7 * 864e5)) d = new Date(year + 1, monthIdx, +day);
  return d;
}

async function fetchAndScanMyNatureLab() {
  const res = await fetch(MY_NATURE_LAB_URL, {
    headers: { "User-Agent": "PlayrouteBot/1.0 (+https://playroute.co)" }
  });
  if (!res.ok) throw new Error(`My Nature Lab fetch failed: ${res.status}`);
  const html = await res.text();
  const text = stripHtmlToText(html);
  const now = new Date();
  const needsReview = [];

  let m;
  while ((m = MY_NATURE_LAB_BLOCK_RE.exec(text)) !== null) {
    const [, rawTitle, sunMonth, sunDay, thuMonthMaybe, thuDay, book, author, animal] = m;
    const thuMonth = thuMonthMaybe || sunMonth; // "and Thursday, 9th" with no repeated month name
    const title = `Story Time: ${rawTitle.trim()}`;

    for (const [dow, month, day] of [["Sunday", sunMonth, sunDay], ["Thursday", thuMonth, thuDay]]) {
      const d = nextDateForMonthDay(month, day, now);
      if (!d) continue;
      const eventDateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      needsReview.push({
        title,
        source: "My Nature Lab",
        city: "Louisville",
        category: "museum",
        cost: "free",
        age_min: 0,
        age_max: 18,
        day_of_week: dow,
        event_date: eventDateStr,
        start_time: "09:15",
        display_time: "9:15 AM – 9:45 AM",
        recurrence: "dated",
        note: `Story: ${book.trim()} by ${author.trim()}. Animal encounter: ${animal.trim()}. Doors open 9am; storytime runs 9:15-9:45. Free, all ages. UNVERIFIED SCRAPE -- selectors written against rendered text, not raw HTML; confirm this matches the live page before trusting it.`,
        source_url: MY_NATURE_LAB_URL,
        raw_excerpt: truncateAtBoundary(m[0], 400),
        dedup_key: `mynaturelab:${eventDateStr}:${rawTitle.trim().toLowerCase().replace(/\s+/g, "-")}`,
        _assumedTime: true, // 09:15 is always hardcoded here, never actually parsed from the page
        _ageGuessed: true   // 0-18 is a broad fallback, not derived from real per-topic age info
      });
    }
  }
  return needsReview;
}

SOURCE_RUNNERS.my_nature_lab = async () => fetchAndScanMyNatureLab();

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
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

// Same privacy model as currentWeekSalt, but rotating monthly instead of
// weekly — needed for MAU. IMPORTANT: this is deliberately a *separate*
// hash (see visitorHashMonth in hashVisitor below), not a wider window on
// the weekly one. The weekly salt rotates every Monday, so a naive
// COUNT(DISTINCT visitor_hash) over a 30-day span would span 4-5 salt
// rotations and could count the same real visitor multiple times. A
// dedicated monthly-rotating hash keeps MAU an honest unique count while
// leaving DAU/WAU untouched.
function currentMonthSalt() {
  const mtNow = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
  return `${mtNow.getFullYear()}-${String(mtNow.getMonth() + 1).padStart(2, "0")}`;
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
// Start of "yesterday" in Mountain Time -- for day-over-day comparisons.
function mountainMidnightYesterdayUTC() {
  const mtNow = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
  mtNow.setDate(mtNow.getDate() - 1);
  return toSqliteUTCString(toMountainDate(mtCalendarDateStr(mtNow), 0, 0));
}
// Start of "last week" (the Monday one week before this week's Monday) in
// Mountain Time -- the start of the comparison window for week-over-week
// stats. Paired with mountainMidnightThisWeekUTC as the window's end.
function mountainMidnightPrevWeekUTC() {
  const mtNow = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
  const day = mtNow.getDay() || 7;
  mtNow.setDate(mtNow.getDate() - day + 1 - 7);
  return toSqliteUTCString(toMountainDate(mtCalendarDateStr(mtNow), 0, 0));
}
// Generalized version of the two helpers above -- the Monday-midnight-MT
// boundary for any week offset (0 = this week's Monday, 1 = last week's,
// 2 = two weeks back, etc; negative values work too, giving a future
// Monday). Built for the WAU trend below, which needs many week boundaries
// rather than just "this" and "last".
function mountainMondayOffsetUTC(weeksAgo) {
  const mtNow = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
  const day = mtNow.getDay() || 7;
  mtNow.setDate(mtNow.getDate() - day + 1 - 7 * weeksAgo);
  return toSqliteUTCString(toMountainDate(mtCalendarDateStr(mtNow), 0, 0));
}
// Start of "this month" (the 1st) in Mountain Time, as the equivalent UTC
// instant -- the MAU counterpart to mountainMidnightThisWeekUTC.
function mountainMidnightThisMonthUTC() {
  const mtNow = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
  mtNow.setDate(1);
  return toSqliteUTCString(toMountainDate(mtCalendarDateStr(mtNow), 0, 0));
}
// Start of "last month" (the 1st of the prior calendar month) in Mountain
// Time -- the comparison window for month-over-month stats, paired with
// mountainMidnightThisMonthUTC as the window's end.
function mountainMidnightPrevMonthUTC() {
  const mtNow = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
  mtNow.setMonth(mtNow.getMonth() - 1, 1);
  return toSqliteUTCString(toMountainDate(mtCalendarDateStr(mtNow), 0, 0));
}

// Returns both hashes -- visitorHash rotates weekly (existing DAU/WAU
// behavior, unchanged), visitorHashMonth rotates monthly (new, for MAU).
// Computed together since they share the same IP+UA input; only the salt
// differs.
async function hashVisitor(request) {
  const ip = request.headers.get("CF-Connecting-IP") || "";
  const ua = request.headers.get("User-Agent") || "";
  const toHex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
  const weeklyData = new TextEncoder().encode(`${ip}|${ua}|${currentWeekSalt()}`);
  const monthlyData = new TextEncoder().encode(`${ip}|${ua}|${currentMonthSalt()}`);
  const [weekBuf, monthBuf] = await Promise.all([
    crypto.subtle.digest("SHA-256", weeklyData),
    crypto.subtle.digest("SHA-256", monthlyData),
  ]);
  return { visitorHash: toHex(weekBuf), visitorHashMonth: toHex(monthBuf) };
}

async function handlePageView(request, env) {
  const { visitorHash, visitorHashMonth } = await hashVisitor(request);
  const cf = request.cf || {};
  const ua = request.headers.get("User-Agent") || "";
  const deviceType = /Mobi|Android/i.test(ua) ? "mobile" : "desktop";
  let source = null;
  try {
    const body = await request.json();
    if (body && body.source) source = String(body.source).slice(0, 50);
  } catch { /* no body / not JSON — fine, organic visit */ }
  await env.DB.prepare(
    `INSERT INTO page_views (visitor_hash, visitor_hash_month, city, country, region, device_type, source) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(visitorHash, visitorHashMonth, cf.city || null, cf.country || null, cf.regionCode || null, deviceType, source).run();
  return json({ ok: true });
}

// What people search for and how many results it returned -- the
// zero-result queries are the real signal here (someone looking for
// "pottery" or "swim lessons" and finding nothing is a direct content-gap
// pointer, more actionable than guessing from click data alone). Debounced
// client-side (see trackSearch() in index.html) so this logs the settled
// query, not every keystroke.
async function handleTrackSearch(request, env) {
  // Search tracking only ever needed the weekly hash -- monthly isn't
  // used here, just destructured and left unused.
  const { visitorHash } = await hashVisitor(request);
  const cf = request.cf || {};
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const query = String(body.query || "").trim().slice(0, 200);
  if (!query) return json({ ok: true, skipped: "empty query" });
  const resultsCount = Number.isFinite(body.resultsCount) ? body.resultsCount : null;
  await env.DB.prepare(
    `INSERT INTO search_queries (query, results_count, visitor_hash, city, country) VALUES (?, ?, ?, ?, ?)`
  ).bind(query, resultsCount, visitorHash, cf.city || null, cf.country || null).run();
  return json({ ok: true });
}

async function handleSearchInsights(env) {
  const days = 30;
  // Zero-result queries first -- these are the direct, actionable signal:
  // someone typed something and Playroute had nothing for it. Grouped by
  // lowercase query text since the same search from different visitors
  // should count as one repeated signal, not scattered rows.
  const zeroResults = await env.DB.prepare(
    `SELECT query, COUNT(*) AS n, MAX(searched_at) AS last_searched
     FROM search_queries
     WHERE results_count = 0 AND searched_at >= datetime('now', ?)
     GROUP BY LOWER(query)
     ORDER BY n DESC, last_searched DESC
     LIMIT 25`
  ).bind(`-${days} days`).all();
  const topSearches = await env.DB.prepare(
    `SELECT query, COUNT(*) AS n, AVG(results_count) AS avg_results
     FROM search_queries
     WHERE searched_at >= datetime('now', ?)
     GROUP BY LOWER(query)
     ORDER BY n DESC
     LIMIT 25`
  ).bind(`-${days} days`).all();
  const totals = await env.DB.prepare(
    `SELECT COUNT(*) AS total, COUNT(DISTINCT visitor_hash) AS unique_searchers,
       SUM(CASE WHEN results_count = 0 THEN 1 ELSE 0 END) AS zero_result_count
     FROM search_queries WHERE searched_at >= datetime('now', ?)`
  ).bind(`-${days} days`).first();
  return json({ days, totals, zeroResults: zeroResults.results, topSearches: topSearches.results });
}

function pctChange(curr, prev) {
  if (!prev) return curr > 0 ? null : 0; // no prior data to compare against — don't claim a % change out of nowhere
  return Math.round(((curr - prev) / prev) * 1000) / 10; // one decimal place
}

// Weekly-active-users for each of the last `weeks` weeks, oldest first --
// lets you actually see a trend over time instead of just this-week-vs-
// last-week. Kept as its own endpoint rather than folded into handleStats,
// since that runs on every dashboard load and doesn't need N extra queries
// every time -- this is a deliberate drill-down the admin panel fetches
// separately.
async function getWauTrend(env, weeks = 12) {
  const trend = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const weekStart = mountainMondayOffsetUTC(i);
    const weekEnd = mountainMondayOffsetUTC(i - 1);
    const row = await env.DB.prepare(
      `SELECT COUNT(DISTINCT visitor_hash) AS n FROM page_views WHERE country = 'US' AND viewed_at >= ? AND viewed_at < ?`
    ).bind(weekStart, weekEnd).first();
    trend.push({
      week_start: weekStart.slice(0, 10),
      is_current_week: i === 0,
      weekly_active_users: row?.n || 0
    });
  }
  return trend;
}

// Referral volume driven to trending/popular events over time -- distinct
// from the badge scoring above (which flags *why* an event is hot); this
// answers "how many people am I actually sending to it, and is that number
// growing." Reads from engagement_digests since source_clicks per event per
// week is already computed there -- no need to re-aggregate raw link_clicks.
//
// Two tiers on purpose: many titles ("Playtime by Reservation", "Connect
// Tour", "Drop-In Tot Time") are genuinely different bookable instances --
// one events-table row per weekday -- that happen to share a name. Comparing
// one instance's this-week count against a *different* instance's last-week
// count isn't a valid week-over-week trend, so instance rows never carry a
// delta. `top_series` aggregates by (event_title, event_city) instead --
// summing across every instance that shares a name at that location -- and
// is the only place a week-over-week comparison is computed.
async function getReferralsTrend(env, weeks = 8) {
  const weeklyTrend = await env.DB.prepare(
    `SELECT week_start,
       SUM(source_clicks) AS total_referrals,
       SUM(CASE WHEN badge IS NOT NULL THEN source_clicks ELSE 0 END) AS badged_referrals
     FROM engagement_digests
     WHERE week_start >= date('now', ?)
     GROUP BY week_start
     ORDER BY week_start ASC`
  ).bind(`-${weeks * 7} days`).all();

  // Tier 1: raw instances at latest week, no delta.
  const topEvents = await env.DB.prepare(
    `SELECT event_id, event_title, event_city, event_category, badge, source_clicks, week_start
     FROM engagement_digests
     WHERE week_start = (SELECT MAX(week_start) FROM engagement_digests)
       AND badge IS NOT NULL
     ORDER BY source_clicks DESC
     LIMIT 15`
  ).all();

  // Tier 2: series-level rollup -- same (event_title, event_city) merged
  // across however many instance event_ids share that name, for the last
  // two scored weeks, so we can compute a real this-week-vs-last-week delta
  // at the level a person actually thinks of as "the event."
  const seriesRows = await env.DB.prepare(
    `SELECT event_title, COALESCE(event_city,'') AS event_city, week_start,
       SUM(source_clicks) AS source_clicks,
       MAX(CASE badge WHEN 'trending' THEN 2 WHEN 'popular' THEN 1 ELSE 0 END) AS badge_rank,
       COUNT(DISTINCT event_id) AS instance_count
     FROM engagement_digests
     WHERE week_start IN (
       SELECT DISTINCT week_start FROM engagement_digests ORDER BY week_start DESC LIMIT 2
     )
     GROUP BY event_title, event_city, week_start`
  ).all();

  const byKey = {};
  for (const r of (seriesRows.results || [])) {
    const key = `${r.event_title}|${r.event_city}`;
    (byKey[key] ||= []).push(r);
  }
  const rankToBadge = { 2: "trending", 1: "popular", 0: null };
  const topSeries = Object.values(byKey)
    .map((weeksForKey) => {
      weeksForKey.sort((a, b) => a.week_start.localeCompare(b.week_start));
      const current = weeksForKey[weeksForKey.length - 1];
      const prior = weeksForKey.length > 1 ? weeksForKey[weeksForKey.length - 2] : null;
      if (current.badge_rank === 0) return null; // not currently badged, skip
      return {
        event_title: current.event_title,
        event_city: current.event_city || null,
        instance_count: current.instance_count,
        badge: rankToBadge[current.badge_rank],
        source_clicks: current.source_clicks,
        prior_week_source_clicks: prior ? prior.source_clicks : null
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.source_clicks - a.source_clicks)
    .slice(0, 15);

  return {
    weekly_trend: weeklyTrend.results || [],
    top_events: topEvents.results || [],
    top_series: topSeries
  };
}

// ── COVERAGE ALERTS ── answers two questions in one place: "which city am I
// about to run dry on" and "which city just doesn't have enough coming up
// right now." Deliberately does NOT try to be a full analytics view --
// only surfaces cities that need attention, so the admin page can show
// nothing at all when everything's fine instead of a wall of green rows.
//
// Tunable thresholds, all in one place:
const COVERAGE_LOOKAHEAD_DAYS = 30; // window used to count "upcoming" dated events
const COVERAGE_DEADLINE_DAYS = 14;  // furthest dated event closer than this = "running out soon"
const COVERAGE_LOW_THRESHOLD = 8;   // fewer than this many dated events in the lookahead window = "low"
const COVERAGE_CRITICAL_THRESHOLD = 3; // fewer than this = "critical"

async function handleCoverageAlerts(env) {
  const { results } = await env.DB.prepare(
    `WITH city_list AS (
       SELECT DISTINCT city FROM events WHERE city IS NOT NULL AND city != ''
     ),
     dated_upcoming AS (
       SELECT city, COUNT(*) AS n
       FROM events
       WHERE event_date IS NOT NULL
         AND event_date >= date('now')
         AND event_date <= date('now', '+${COVERAGE_LOOKAHEAD_DAYS} days')
       GROUP BY city
     ),
     recurring_active AS (
       -- Weekly/monthly recurring rows have no event_date and don't "run
       -- out" the way a dated/seasonal listing does -- counted separately
       -- as a baseline, not folded into dated_upcoming.
       SELECT city, COUNT(*) AS n
       FROM events
       WHERE event_date IS NULL
       GROUP BY city
     ),
     furthest_dated AS (
       SELECT city, MAX(event_date) AS last_date
       FROM events
       WHERE event_date IS NOT NULL AND event_date >= date('now')
       GROUP BY city
     )
     SELECT
       cl.city,
       COALESCE(du.n, 0) AS dated_next_30d,
       COALESCE(ra.n, 0) AS recurring_active,
       fd.last_date AS runway_end,
       CAST(julianday(fd.last_date) - julianday('now') AS INTEGER) AS runway_days
     FROM city_list cl
     LEFT JOIN dated_upcoming du ON du.city = cl.city
     LEFT JOIN recurring_active ra ON ra.city = cl.city
     LEFT JOIN furthest_dated fd ON fd.city = cl.city
     ORDER BY dated_next_30d ASC`
  ).all();

  const alerts = [];
  for (const row of results) {
    // Priority order matters -- a city can technically match more than one
    // condition, but each city gets exactly ONE status: the most urgent
    // thing true about it, not a pile of overlapping badges.
    let status = null, message = null;
    if (row.runway_end === null) {
      status = "critical";
      message = `No upcoming dated events at all${row.recurring_active > 0 ? ` (only ${row.recurring_active} recurring listing${row.recurring_active === 1 ? "" : "s"})` : ""}`;
    } else if (row.runway_days <= COVERAGE_DEADLINE_DAYS) {
      status = "deadline";
      message = row.runway_days <= 0
        ? `Dated coverage already ran out (last known event was ${row.runway_end})`
        : `Dated coverage runs out in ${row.runway_days} day${row.runway_days === 1 ? "" : "s"} (${row.runway_end})`;
    } else if (row.dated_next_30d < COVERAGE_CRITICAL_THRESHOLD) {
      status = "critical";
      message = `Only ${row.dated_next_30d} dated event${row.dated_next_30d === 1 ? "" : "s"} in the next ${COVERAGE_LOOKAHEAD_DAYS} days`;
    } else if (row.dated_next_30d < COVERAGE_LOW_THRESHOLD) {
      status = "low";
      message = `Just ${row.dated_next_30d} dated events in the next ${COVERAGE_LOOKAHEAD_DAYS} days`;
    }
    if (status) {
      alerts.push({ city: row.city, status, message, dated_next_30d: row.dated_next_30d, recurring_active: row.recurring_active, runway_end: row.runway_end });
    }
  }
  // Worst first: critical, then deadline, then low.
  const order = { critical: 0, deadline: 1, low: 2 };
  alerts.sort((a, b) => order[a.status] - order[b.status]);
  return json({ alerts, checkedCities: results.length, generatedAt: new Date().toISOString() });
}

async function handleStats(env) {

  const todayStart = mountainMidnightTodayUTC();
  const weekStart = mountainMidnightThisWeekUTC();
  const yesterdayStart = mountainMidnightYesterdayUTC();
  const prevWeekStart = mountainMidnightPrevWeekUTC();
  const monthStart = mountainMidnightThisMonthUTC();
  const prevMonthStart = mountainMidnightPrevMonthUTC();
  // Filtering to US only — your product is Colorado-specific, but country-level
  // geo data (from Cloudflare's edge) is reliable enough to use as the main
  // filter; state-level data below is a bonus, finer-grained signal on top.
  const US = `AND country = 'US'`;

  const dau = await env.DB.prepare(
    `SELECT COUNT(DISTINCT visitor_hash) AS n FROM page_views WHERE viewed_at >= ? ${US}`
  ).bind(todayStart).first();
  // "Yesterday" as a comparison window: from yesterday's midnight up to (not
  // including) today's midnight -- a clean full-day window, not "last 24h".
  const dauPrev = await env.DB.prepare(
    `SELECT COUNT(DISTINCT visitor_hash) AS n FROM page_views WHERE viewed_at >= ? AND viewed_at < ? ${US}`
  ).bind(yesterdayStart, todayStart).first();
  const wau = await env.DB.prepare(
    `SELECT COUNT(DISTINCT visitor_hash) AS n FROM page_views WHERE viewed_at >= ? ${US}`
  ).bind(weekStart).first();
  const wauPrev = await env.DB.prepare(
    `SELECT COUNT(DISTINCT visitor_hash) AS n FROM page_views WHERE viewed_at >= ? AND viewed_at < ? ${US}`
  ).bind(prevWeekStart, weekStart).first();
  // MAU uses visitor_hash_month, NOT visitor_hash -- the weekly hash rotates
  // every Monday, so counting DISTINCT visitor_hash across a full calendar
  // month would span 4-5 salt rotations and overcount real unique visitors.
  // See currentMonthSalt() for why this needed its own hash column.
  const mau = await env.DB.prepare(
    `SELECT COUNT(DISTINCT visitor_hash_month) AS n FROM page_views WHERE viewed_at >= ? ${US}`
  ).bind(monthStart).first();
  const mauPrev = await env.DB.prepare(
    `SELECT COUNT(DISTINCT visitor_hash_month) AS n FROM page_views WHERE viewed_at >= ? AND viewed_at < ? ${US}`
  ).bind(prevMonthStart, monthStart).first();
  const totalViewsThisWeek = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM page_views WHERE viewed_at >= ? ${US}`
  ).bind(weekStart).first();
  const totalViewsPrevWeek = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM page_views WHERE viewed_at >= ? AND viewed_at < ? ${US}`
  ).bind(prevWeekStart, weekStart).first();
  const byDevice = await env.DB.prepare(
    `SELECT device_type, COUNT(DISTINCT visitor_hash) AS n FROM page_views WHERE viewed_at >= ? ${US} GROUP BY device_type`
  ).bind(weekStart).all();
  const byCity = await env.DB.prepare(
    `SELECT city, COUNT(DISTINCT visitor_hash) AS n FROM page_views WHERE viewed_at >= ? ${US} AND city IS NOT NULL GROUP BY city ORDER BY n DESC LIMIT 10`
  ).bind(weekStart).all();

  // Bonus, more precise signal: Cloudflare gives state-level geo for free
  // (cf.regionCode), not just country. Since this product is Colorado-only,
  // this tells you what fraction of "US" visits are actually in-state —
  // useful for spotting e.g. VPN traffic or out-of-market curiosity clicks
  // that a country-level filter alone can't catch.
  const coloradoVisitors7d = await env.DB.prepare(
    `SELECT COUNT(DISTINCT visitor_hash) AS n FROM page_views WHERE viewed_at >= ? ${US} AND region = 'CO'`
  ).bind(weekStart).first();
  const byRegion7d = await env.DB.prepare(
    `SELECT region, COUNT(DISTINCT visitor_hash) AS n FROM page_views WHERE viewed_at >= ? ${US} AND region IS NOT NULL GROUP BY region ORDER BY n DESC LIMIT 10`
  ).bind(weekStart).all();

  // Visits that came specifically from clicking the link in a digest email
  // (tagged ?src=newsletter) — lets you see whether the newsletter is
  // actually driving people back into the app, separate from organic visits.
  const newsletterVisits1d = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM page_views WHERE viewed_at >= ? ${US} AND source = 'newsletter'`
  ).bind(todayStart).first();
  const newsletterVisits7d = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM page_views WHERE viewed_at >= ? ${US} AND source = 'newsletter'`
  ).bind(weekStart).first();
  const newsletterVisits7dPrev = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM page_views WHERE viewed_at >= ? AND viewed_at < ? ${US} AND source = 'newsletter'`
  ).bind(prevWeekStart, weekStart).first();
  const newsletterVisitors7d = await env.DB.prepare(
    `SELECT COUNT(DISTINCT visitor_hash) AS n FROM page_views WHERE viewed_at >= ? ${US} AND source = 'newsletter'`
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
  const totalClicks7dPrev = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM link_clicks WHERE clicked_at >= ? AND clicked_at < ?`
  ).bind(prevWeekStart, weekStart).first();

  // "Events discovered, all time" — a promotable number for the app itself.
  // Counts every real signal someone found an event useful: expanding a card
  // to read details, clicking through to the source, or adding it to their
  // calendar. Deliberately excludes "Open in Maps" clicks on playgrounds/hikes
  // and the coffee/feedback links, since those aren't about discovering an
  // event. Note: this counts actions, not deduplicated unique events — someone
  // expanding, then clicking source, then adding to calendar for the same
  // event counts as 3, which is an honest reflection of engagement depth,
  // not an inflated number pretending to be unique events. No "previous
  // period" here on purpose -- it's a cumulative all-time counter, so a
  // period-over-period comparison wouldn't mean anything.
  const eventsDiscoveredAllTime = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM link_clicks WHERE category NOT IN ('playground','hike','support')`
  ).first();

  const dauN = dau?.n || 0, dauPrevN = dauPrev?.n || 0;
  const wauN = wau?.n || 0, wauPrevN = wauPrev?.n || 0;
  const mauN = mau?.n || 0, mauPrevN = mauPrev?.n || 0;
  const views7dN = totalViewsThisWeek?.n || 0, views7dPrevN = totalViewsPrevWeek?.n || 0;
  const clicks7dN = totalClicks7d?.n || 0, clicks7dPrevN = totalClicks7dPrev?.n || 0;
  const newsletter7dN = newsletterVisits7d?.n || 0, newsletter7dPrevN = newsletterVisits7dPrev?.n || 0;

  // --- All-time metrics ---------------------------------------------------
  // Meant for advertiser-facing numbers, not day-to-day monitoring. Pulls
  // from the same page_views/link_clicks tables, just with no date filter.
  // IMPORTANT: "all time" really means "since analytics tracking started"
  // (see tracking_since below) — the README already notes tracking doesn't
  // cover the app's full history, so don't quote these as if they do.
  const trackingSince = await env.DB.prepare(
    `SELECT MIN(viewed_at) AS d FROM page_views WHERE country = 'US'`
  ).first();
  const pageViewsAllTime = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM page_views WHERE country = 'US'`
  ).first();
  // "All-time" unique visitors, patched to reduce (not eliminate) the same
  // overcounting problem MAU had to solve. visitor_hash rotates weekly, so
  // COUNT(DISTINCT visitor_hash) across the app's entire lifetime spans
  // every weekly rotation since tracking_since -- a single real visitor who
  // returns across multiple weeks gets counted once per week they showed up.
  //
  // Fix: prefer visitor_hash_month (rotates monthly, ~4x fewer rotations
  // per year than the weekly hash) wherever it's populated, and only fall
  // back to visitor_hash for rows written before this column existed. That
  // fallback period is small and fixed (everything before this deploy) and
  // won't grow, so its contribution to the overcount shrinks over time as a
  // share of total traffic.
  //
  // This is a real improvement, not a full fix -- visitor_hash_month still
  // rotates, so a visitor active in both July and September is still two
  // distinct hashes. A fully accurate all-time unique count would need a
  // non-rotating (or very-long-rotating) identifier, which is a deliberate
  // trade this app doesn't make -- see currentWeekSalt()'s privacy comment.
  // If a truly accurate lifetime number ever matters more than the current
  // privacy model, that's a product decision, not just a query fix.
  const uniqueVisitorsAllTime = await env.DB.prepare(
    `SELECT COUNT(DISTINCT COALESCE(visitor_hash_month, visitor_hash)) AS n FROM page_views WHERE country = 'US'`
  ).first();
  const coloradoVisitorsAllTime = await env.DB.prepare(
    `SELECT COUNT(DISTINCT COALESCE(visitor_hash_month, visitor_hash)) AS n FROM page_views WHERE country = 'US' AND region = 'CO'`
  ).first();
  const linkClicksAllTime = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM link_clicks`
  ).first();
  const activeSubscribers = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM subscribers WHERE active = 1`
  ).first();
  const contentCounts = await env.DB.prepare(
    `SELECT
      (SELECT COUNT(*) FROM events) AS events,
      (SELECT COUNT(*) FROM playgrounds) AS playgrounds,
      (SELECT COUNT(*) FROM hikes) AS hikes,
      (SELECT COUNT(*) FROM (SELECT city FROM playgrounds UNION SELECT city FROM hikes UNION SELECT city FROM events)) AS cities`
  ).first();

  const uniqueAllTimeN = uniqueVisitorsAllTime?.n || 0;
  const coloradoAllTimeN = coloradoVisitorsAllTime?.n || 0;

  return json({
    monthly_active_users: mauN,
    monthly_active_users_prev: mauPrevN,
    monthly_active_users_change_pct: pctChange(mauN, mauPrevN),
    weekly_active_users: wauN,
    weekly_active_users_prev: wauPrevN,
    weekly_active_users_change_pct: pctChange(wauN, wauPrevN),
    daily_active_users: dauN,
    daily_active_users_prev: dauPrevN,
    daily_active_users_change_pct: pctChange(dauN, dauPrevN),
    page_views_7d: views7dN,
    page_views_7d_prev: views7dPrevN,
    page_views_7d_change_pct: pctChange(views7dN, views7dPrevN),
    by_device_7d: byDevice.results || [],
    top_cities_7d: byCity.results || [],
    colorado_visitors_7d: coloradoVisitors7d?.n || 0,
    by_region_7d: byRegion7d.results || [],
    newsletter_visits_1d: newsletterVisits1d?.n || 0,
    newsletter_visits_7d: newsletter7dN,
    newsletter_visits_7d_prev: newsletter7dPrevN,
    newsletter_visits_7d_change_pct: pctChange(newsletter7dN, newsletter7dPrevN),
    newsletter_unique_visitors_7d: newsletterVisitors7d?.n || 0,
    link_clicks_1d: totalClicks1d?.n || 0,
    link_clicks_7d: clicks7dN,
    link_clicks_7d_prev: clicks7dPrevN,
    link_clicks_7d_change_pct: pctChange(clicks7dN, clicks7dPrevN),
    link_clicks_by_type_1d: clicksByType1d.results || [],
    link_clicks_by_type_7d: clicksByType7d.results || [],
    events_discovered_all_time: eventsDiscoveredAllTime?.n || 0,
    all_time: {
      tracking_since: trackingSince?.d || null,
      page_views: pageViewsAllTime?.n || 0,
      unique_visitors: uniqueAllTimeN,
      colorado_visitors: coloradoAllTimeN,
      colorado_visitor_pct: uniqueAllTimeN > 0 ? Math.round((coloradoAllTimeN / uniqueAllTimeN) * 100) : null,
      link_clicks: linkClicksAllTime?.n || 0,
      active_subscribers: activeSubscribers?.n || 0,
      total_events: contentCounts?.events || 0,
      total_playgrounds: contentCounts?.playgrounds || 0,
      total_hikes: contentCounts?.hikes || 0,
      cities_covered: contentCounts?.cities || 0
    }
  });
}

async function upsertEvent(env, ev) {
  await env.DB.prepare(
    `INSERT INTO events
      (title, source, city, category, cost, age_min, age_max, day_of_week,
       start_time, display_time, recurrence, event_date, note, source_url,
       verified, libcal_event_id, season_start, season_end, source_id, last_scraped_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(libcal_event_id) WHERE libcal_event_id IS NOT NULL DO UPDATE SET
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
       source_id=excluded.source_id,
       last_scraped_at=CURRENT_TIMESTAMP
     ON CONFLICT(title, city, source, day_of_week, start_time, COALESCE(event_date,'')) DO UPDATE SET
       category=excluded.category,
       cost=excluded.cost,
       age_min=excluded.age_min,
       age_max=excluded.age_max,
       recurrence=excluded.recurrence,
       note=excluded.note,
       source_url=excluded.source_url,
       verified=excluded.verified,
       libcal_event_id=excluded.libcal_event_id,
       season_start=excluded.season_start,
       season_end=excluded.season_end,
       source_id=excluded.source_id,
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
    ev.season_end ?? null,
    ev.source_id ?? null
  ).run();
}

// Boulder and Erie each get their own runner (rather than one runner
// looping both) so they're tracked and error-isolated separately in
// scrape_sources — one failing shouldn't obscure the other's last_run_at.
SOURCE_RUNNERS.boulder_ical = async () => {
  const lib = ICAL_LIBRARIES.find((l) => l.city === "Boulder");
  return fetchAndNormalizeICalFeed(lib.url, lib.city, { trustSourceFilter: lib.trustSourceFilter });
};
SOURCE_RUNNERS.erie_ical = async () => {
  const lib = ICAL_LIBRARIES.find((l) => l.city === "Erie");
  return fetchAndNormalizeICalFeed(lib.url, lib.city, { trustSourceFilter: lib.trustSourceFilter });
};

async function handleEvents(env, url) {
  const city = url.searchParams.get("city");
  const category = url.searchParams.get("category");
  const cost = url.searchParams.get("cost");
  const ageBucket = url.searchParams.get("age");
  const includeIrregular = url.searchParams.get("includeIrregular") === "1";
  // How far ahead to fetch dated one-off events by default. Without this,
  // the query returns literally every future dated event no matter how far
  // out (some are 6+ months away), and that payload only grows as more
  // events get added -- it had reached ~500KB/522 events with no ceiling in
  // sight. Weekly/monthly recurring events are unaffected by this (they
  // have no event_date to filter on, and are inherently "always soon"
  // since occurrence is computed as next-from-now). A `days` param lets a
  // future "browse further ahead" UI feature request a wider window
  // explicitly; the default keeps the common case small.
  const forwardDays = Math.min(Math.max(parseInt(url.searchParams.get("days")) || 90, 7), 365);
  const conditions = [
    `(recurrence != 'dated' OR (event_date >= date('now','-1 day') AND event_date <= date('now', ?)))`
  ];
  const binds = [`+${forwardDays} days`];
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
  const where = `WHERE ${conditions.join(" AND ")}`;
  const { results } = await env.DB.prepare(
    `SELECT *, (created_at >= datetime('now','-7 days')) AS is_new FROM events ${where}`
  ).bind(...binds).all();

  // Attach this week's engagement badge, if any. Computed weekly by
  // runWeeklyEngagementDigest (see the Sunday cron branch below) —
  // 'trending' means this week's clicks/calendar-adds/shares are running
  // well above that event's own recent average, 'popular' means it's in the
  // top slice by raw volume this week regardless of trend direction. Most
  // events get neither, which is the point — a badge on everything means
  // nothing.
  const badgeRows = await env.DB.prepare(
    `SELECT event_id, badge FROM engagement_digests
     WHERE week_start = (SELECT MAX(week_start) FROM engagement_digests) AND badge IS NOT NULL`
  ).all();
  const badgeByEventId = new Map(badgeRows.results.map((r) => [r.event_id, r.badge]));

  const now = new Date();
  const withOccurrence = [];
  const irregular = [];
  for (const ev of results) {
    ev.badge = badgeByEventId.get(ev.id) || null;
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
  // Short cache window (not the shared json() helper's headers, which are
  // used by many endpoints with different freshness needs) -- lets a quick
  // repeat refresh (exactly what someone frustrated by a slow load tends to
  // do) hit the browser's HTTP cache instead of re-downloading the full
  // payload from scratch every time. 3 minutes balances that against still
  // picking up admin-approved changes reasonably promptly.
  return Response.json([...withOccurrence, ...irregular], {
    headers: { ...CORS_HEADERS, "Cache-Control": "public, max-age=180" }
  });
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

// Recognized action_type values. 'category' historically also carried these
// same strings for a few click sites (card_expand/calendar/share/support),
// which meant a single column did double duty as both "what type of click
// was this" and "what category is this event" depending on which button was
// clicked — that made cross-event engagement analysis unreliable. action_type
// is now the dedicated field for that; category (when sent) stays the real
// event category throughout.
const KNOWN_ACTION_TYPES = new Set(["view_details", "add_to_calendar", "share", "support_click", "source_click"]);

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
  // Back-compat: older cached frontend bundles may still send an
  // action-type string in `category` and no `action` at all. Prefer the
  // explicit `action` field; fall back to inferring it from `category` so
  // in-flight clients don't silently stop being tracked during rollout.
  const action = KNOWN_ACTION_TYPES.has(body.action)
    ? body.action
    : (KNOWN_ACTION_TYPES.has(body.category) ? body.category : "source_click");
  const category = KNOWN_ACTION_TYPES.has(body.category) ? null : (body.category ?? null);
  await env.DB.prepare(
    `INSERT INTO link_clicks (event_id, event_title, city, category, source_url, action_type)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(body.event_id ?? null, body.event_title, body.city ?? null, category, body.source_url, action).run();
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

  // Same pipeline as every other source now — validate, dedupe (on a
  // stable key, not whatever the caller happened to pass), queue into
  // pending_events. No more INGEST_REVIEW_MODE branch; this always queues.
  const queued = [];
  const skipped = [];
  for (const ev of events) {
    const result = await ingestCandidate(env, { source_key: "external_ingest", confidence: "review" }, ev);
    if (result.reason === "duplicate-in-events") {
      skipped.push({ title: ev.title, reason: "already exists in events" });
    } else if (result.queued) {
      queued.push({ title: ev.title, severity: result.severity });
    } else {
      skipped.push({ title: ev.title, reason: "duplicate pending candidate" });
    }
  }
  return json({ queued: queued.length, skipped: skipped.length, details: { queued, skipped } });
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
const DIGEST_MAX_DAYS = 7;

function escapeHtml(s) {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Some older scraped `source` values have the full street address baked
// right in (e.g. "...— Steinbaugh Pavilion, 824 Front St"), while newer
// entries keep source to just the org/venue name and put the address in
// `note` instead. Left as-is, the digest shows an address on some events
// and not others with no visible pattern. This strips any address-shaped
// fragment (a street number, a "1300 block" reference, a trailing state+
// zip) so the digest is consistent regardless of how the source data was
// originally entered -- doesn't touch the underlying DB field, just the
// email's display copy.
function cleanSourceForDisplay(source) {
  if (!source) return "";
  let s = source.replace(/,?\s*\b[A-Z]{2}\s+\d{5}\b/g, "");
  s = s
    .split(",")
    .map((seg) =>
      seg.split("—").map((part) => part.trim()).filter((part) => part && !/^\d/.test(part)).join(" — ")
    )
    .filter(Boolean)
    .join(", ");
  return s.replace(/\s*—\s*$/, "").trim();
}

async function getWeekAheadEvents(env) {
  const { results } = await env.DB.prepare("SELECT * FROM events").all();
  const now = new Date();
  // The digest should cover "starting tomorrow," not "starting right now" --
  // sending Sunday's own remaining events in a Sunday digest is redundant
  // (anyone who'd see it in their inbox that morning could've already
  // caught it in the app), and reads oddly next to "This week" framing that
  // implies what's still ahead. Computed the same DST-aware way as the
  // other mountainMidnight* helpers in this file (see below) rather than a
  // naive +24h, which would drift across the spring/fall DST transitions.
  const mtNow = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
  mtNow.setDate(mtNow.getDate() + 1);
  const windowStart = toMountainDate(mtCalendarDateStr(mtNow), 0, 0);
  const cutoff = new Date(windowStart.getTime() + DIGEST_MAX_DAYS * 864e5);
  // Used to build a subject line that actually varies week to week (see
  // runWeeklyDigest) -- Gmail threads emails by matching subject text, so
  // a fully static subject like "This week on Playroute" sent every single
  // week would merge every week's digest into one ever-growing thread,
  // collapsing all but the latest behind "Show trimmed/quoted content."
  const startLabel = windowStart.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: TZ });
  const endLabel = cutoff.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: TZ });
  // Only abbreviate the end date to just a day number when both dates
  // share a month (e.g. "Aug 3-9") -- across a month boundary, spelling
  // out both months avoids a confusing "Jul 31-7" with no month on the "7".
  const sameMonth = startLabel.split(" ")[0] === endLabel.split(" ")[0];
  const weekLabel = sameMonth ? `${startLabel}\u2013${endLabel.split(" ")[1]}` : `${startLabel}\u2013${endLabel}`;

  // Same badge lookup handleEvents() uses for the site — see
  // runWeeklyEngagementDigest(). Subscribers should see the same
  // trending/popular signal site visitors do, not a stripped-down version.
  const latestWeek = await env.DB.prepare(`SELECT MAX(week_start) AS w FROM engagement_digests`).first();
  let badgeByEventId = new Map();
  if (latestWeek?.w) {
    const badgeRows = await env.DB.prepare(
      `SELECT event_id, badge FROM engagement_digests WHERE week_start = ? AND badge IS NOT NULL`
    ).bind(latestWeek.w).all();
    badgeByEventId = new Map(badgeRows.results.map((r) => [r.event_id, r.badge]));
  }

  const withOccurrence = [];
  for (const ev of results) {
    if (ev.recurrence === "irregular") continue;
    const occ = getOccurrence(ev, windowStart);
    if (!occ || occ > cutoff) continue;
    withOccurrence.push({ ...ev, occurrence: occ, occurrence_label: formatOccurrenceLabel(occ), badge: badgeByEventId.get(ev.id) || null });
  }
  // Chronological sort BEFORE grouping into days -- byDayAll below is a Map
  // keyed by day label, and Map preserves insertion order. Without this
  // sort, days land in whatever order the SQL query happened to return
  // rows in (not chronological), which is exactly the bug that shipped:
  // the interest-score rewrite replaced the old sort but never restored an
  // equivalent one before day-grouping.
  withOccurrence.sort((a, b) => a.occurrence - b.occurrence);

  // "Most interesting to parents" isn't cost tier -- it's whether the event
  // is actually notable. Trending/popular badges are the strongest signal
  // (real engagement data); a one-off dated special (is_special) is the
  // next best signal even before it's accumulated any clicks (a new farm
  // festival won't have engagement history yet, but it's still clearly
  // more noteworthy than a routine weekly storytime). A small freshness
  // bonus for recently-added events (is_new) gives brand-new listings a
  // fighting chance against established badge-holders, rather than always
  // losing out until they've accumulated a week of clicks. Routine
  // recurring events are the baseline. This replaces an earlier
  // free-before-paid sort that technically prevented an early paid drop-in
  // from always winning the top slot, but overcorrected into crowding paid
  // events out of the digest entirely on days with several free options.
  function interestScore(ev) {
    let score = 0;
    if (ev.badge === "trending") score = 3;
    else if (ev.badge === "popular") score = 2;
    else if (ev.is_special) score = 1;
    if (ev.is_new) score += 0.5;
    return score;
  }

  const byDayAll = new Map();
  for (const ev of withOccurrence) {
    const list = byDayAll.get(ev.occurrence_label) || [];
    list.push(ev);
    byDayAll.set(ev.occurrence_label, list);
  }

  // Group by day, capping how many show per day so the email stays
  // skimmable. `total` tracks how many actually occur that day (before the
  // cap) so the render step can show a "+N more" prompt back to Playroute
  // instead of silently dropping them with no indication more exist.
  const byDay = new Map();
  for (const [label, dayEvents] of byDayAll) {
    const total = dayEvents.length;
    const ranked = dayEvents.slice().sort((a, b) => {
      const scoreDiff = interestScore(b) - interestScore(a);
      if (scoreDiff !== 0) return scoreDiff;
      return a.occurrence - b.occurrence;
    });
    let shown = ranked.slice(0, DIGEST_MAX_PER_DAY);

    // Balance backstop: if the top picks came out all one cost tier but
    // the day actually has an event from the other tier, swap in the
    // single best-scored one -- guarantees a real mix instead of, say, six
    // free storytimes crowding out the one great paid class that day.
    const tiers = new Set(shown.map((e) => e.cost));
    if (tiers.size === 1 && shown.length === DIGEST_MAX_PER_DAY) {
      const missingTier = shown[0].cost === "free" ? "paid" : "free";
      const bestOfMissing = ranked.find((e) => e.cost === missingTier);
      if (bestOfMissing) {
        const worstIdx = shown.length - 1; // lowest-ranked of the overrepresented tier
        shown = [...shown.slice(0, worstIdx), bestOfMissing];
      }
    }

    // Display order is chronological within the day regardless of how
    // picks were selected -- ranking by "interest" is for choosing which
    // events make the cut, not for the order a reader sees them in.
    shown.sort((a, b) => a.occurrence - b.occurrence);
    byDay.set(label, { shown, total });
  }

  // Spotlight picks for the top-of-email highlight section: the most
  // genuinely notable events of the week, reusing the same interest score
  // as day-level selection above (trending > popular > one-off special,
  // plus a freshness nudge). Deliberately NOT limited to weekly-recurring
  // events -- a one-off farm festival or concert is exactly the kind of
  // thing worth surfacing here, it just won't have a badge yet if it's
  // brand new.
  //
  // Diversity-aware on purpose, not just top-3 by raw score: without this,
  // 3 similar high-scoring events (e.g. three different storytimes that
  // all happen to be trending) can crowd out a great one-off in a
  // different category, and the "best picks" section reads as repetitive
  // week over week. Greedily picks the single best-scored event per
  // category first, then only reuses a category if there genuinely aren't
  // 3 distinct categories worth including.
  const spotlightCandidates = withOccurrence
    .filter((ev) => interestScore(ev) > 0)
    .sort((a, b) => {
      const scoreDiff = interestScore(b) - interestScore(a);
      if (scoreDiff !== 0) return scoreDiff;
      return a.occurrence - b.occurrence;
    });
  const spotlight = [];
  const usedCategories = new Set();
  for (const ev of spotlightCandidates) {
    if (spotlight.length >= 3) break;
    if (usedCategories.has(ev.category)) continue;
    spotlight.push(ev);
    usedCategories.add(ev.category);
  }
  if (spotlight.length < 3) {
    for (const ev of spotlightCandidates) {
      if (spotlight.length >= 3) break;
      if (spotlight.includes(ev)) continue;
      spotlight.push(ev);
    }
  }

  // Same real number used elsewhere (/api/public-stats, the app footer) --
  // total tracked interactions with event content, not a fabricated figure.
  const statRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM link_clicks WHERE category NOT IN ('playground','hike','support')`
  ).first();

  return { byDay, spotlight, eventsDiscovered: statRow?.n || 0, weekLabel };
}

// Category icons for the email -- same shapes as the app's blaze icon set
// (public/index.html) so the newsletter visually matches the app instead of
// looking like a generic email template. NOTE: inline SVG has patchy
// support in Outlook desktop specifically (Word rendering engine) though it
// works fine in Gmail, Apple Mail, and Outlook web/mobile. Given the
// audience mostly opens on phones this is an acceptable tradeoff for now,
// but flagging it: if Outlook-desktop rendering turns out to matter, these
// would need to become small PNGs instead.
// Category colors for the email -- matches the app's category icon colors,
// but rendered as a plain colored block instead of an SVG shape. Inline
// SVG in email is NOT reliably supported (confirmed broken on Gmail
// Android specifically, and generally unreliable across clients beyond
// Apple Mail) -- a table cell with a background color has zero image/SVG
// dependency and renders identically everywhere, which matters more here
// than the shape did. If real per-category icon imagery is wanted later,
// the safe path is small hosted PNGs referenced by <img src>, not inline
// SVG or CSS shapes relying on unsupported properties.
const DIGEST_CATEGORY_COLORS = {
  library: "#7A5568",
  rec: "#6E8B8A",
  museum: "#C79A4B",
  outdoor: "#B4805A",
  community: "#9B8AAE",
  farmers_market: "#B85C4A"
};
function digestColorBlock(category, size) {
  const color = DIGEST_CATEGORY_COLORS[category] || DIGEST_CATEGORY_COLORS.outdoor;
  return `<table role="presentation" width="${size}" height="${size}" cellpadding="0" cellspacing="0"><tr><td bgcolor="${color}" width="${size}" height="${size}" style="border-radius:${Math.round(size / 3)}px;font-size:0;line-height:0;">&nbsp;</td></tr></table>`;
}

function digestBadgeHtml(badge) {
  if (badge === "trending") return `<span style="display:inline-block;background:#B23368;color:#fff;font-size:10px;font-weight:700;letter-spacing:0.03em;padding:2px 7px;border-radius:20px;margin-top:4px;">TRENDING</span>`;
  if (badge === "popular") return `<span style="display:inline-block;background:#A6791E;color:#fff;font-size:10px;font-weight:700;letter-spacing:0.03em;padding:2px 7px;border-radius:20px;margin-top:4px;">POPULAR</span>`;
  return "";
}

function buildDigestHtml(byDay, spotlight, eventsDiscovered, unsubscribeUrl) {
  const days = [...byDay.entries()];
  const ctaButton = (label) => `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:14px 0;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr><td align="center" bgcolor="#A8623A" style="border-radius:10px;">
        <a href="${DIGEST_SITE_URL}/?src=newsletter" style="display:block;padding:13px 20px;font-family:-apple-system,sans-serif;font-size:14.5px;font-weight:700;color:#ffffff;text-decoration:none;">${label} \u2192</a>
      </td></tr></table>
    </td></tr></table>`;

  const spotlightHtml = spotlight.length ? `
    <p style="padding:22px 24px 8px;margin:0;font-size:11px;font-weight:700;letter-spacing:0.09em;text-transform:uppercase;color:#3C5548;font-family:-apple-system,sans-serif;">Don't miss these</p>
    ${spotlight.map((ev) => {
      const cleanSource = cleanSourceForDisplay(ev.source);
      // Each spotlight card is a full <a> block wrapping the whole table so
      // the entire card (not just a "more" link elsewhere) is tappable --
      // previously these cards had no href at all. display:block + color:
      // inherit keeps the link from visually looking/behaving like inline
      // text while remaining a single tap target on mobile mail clients.
      return `
      <a href="${DIGEST_SITE_URL}/?src=newsletter" style="display:block;text-decoration:none;color:inherit;margin:0 24px 12px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;background:#F1E7D2;border:1px solid #D3D8C8;border-radius:14px;">
        <tr>
          <td width="46" style="padding:14px 0 14px 14px;vertical-align:top;">
            ${digestColorBlock(ev.category, 34)}
          </td>
          <td style="padding:14px 14px 14px 10px;font-family:-apple-system,sans-serif;">
            <div style="font-weight:700;font-size:15px;color:#1F2A22;">${escapeHtml(ev.title)}</div>
            <div style="font-size:12px;color:#6B7268;margin-top:3px;">${escapeHtml(cleanSource)}${cleanSource ? " \u00B7 " : ""}${escapeHtml(ev.city)} \u00B7 ${escapeHtml(ev.occurrence_label)}, ${escapeHtml(ev.display_time)}</div>
            ${digestBadgeHtml(ev.badge)}
          </td>
        </tr>
      </table>
      </a>`;
    }).join("")}
  ` : "";

  const dayBlocks = days.map(([label, { shown, total }]) => {
    const rows = shown.map((ev) => {
      const cleanSource = cleanSourceForDisplay(ev.source);
      // Same fix as the spotlight cards above: wrap the row content in an
      // <a> (via a block-level anchor inside the cell, since <a> can't
      // legally wrap a <tr>/<td> directly) so each daily list item opens
      // Playroute instead of being inert text.
      return `
      <tr>
        <td width="24" valign="top" style="padding:9px 0;">${digestColorBlock(ev.category, 16)}</td>
        <td style="padding:0;border-bottom:1px solid #F1E7D2;">
          <a href="${DIGEST_SITE_URL}/?src=newsletter" style="display:block;text-decoration:none;color:inherit;padding:9px 0 9px 10px;font-family:-apple-system,sans-serif;">
            <div style="font-weight:600;font-size:13.5px;color:#1F2A22;">${escapeHtml(ev.title)}</div>
            <div style="font-size:11.5px;color:#6B7268;margin-top:2px;">${escapeHtml(cleanSource)}${cleanSource ? " \u00B7 " : ""}${escapeHtml(ev.display_time)}</div>
            <span style="display:inline-block;font-size:10px;font-weight:600;padding:2px 7px;border-radius:6px;margin-top:4px;${ev.cost === "free" ? "background:#D4EBC9;color:#3A5C2A;" : "background:#E8DED0;color:#5C4A38;"}">${ev.cost === "free" ? "Free" : "Paid"}</span>
            ${ev.is_new ? `<span style="display:inline-block;font-size:10px;font-weight:600;padding:2px 7px;border-radius:6px;margin:4px 0 0 4px;background:#3C5548;color:#fff;">New</span>` : ""}
          </a>
        </td>
      </tr>`;
    }).join("");
    const overflow = total - shown.length;
    const overflowRow = overflow > 0
      ? `<tr><td colspan="2" style="padding:8px 0 2px;font-family:-apple-system,sans-serif;font-size:12.5px;">
           <a href="${DIGEST_SITE_URL}/?src=newsletter" style="color:#9B5C2A;font-weight:700;text-decoration:none;">+ ${overflow} more event${overflow === 1 ? "" : "s"} on Playroute \u2192</a>
         </td></tr>`
      : "";
    return `
      <p style="margin:18px 24px 8px;padding:0;"><span style="font-size:12px;font-weight:700;color:#1F2A22;background:#D3D8C8;padding:3px 11px;border-radius:20px;font-family:-apple-system,sans-serif;">${escapeHtml(label)}</span></p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 24px;width:calc(100% - 48px);">${rows}${overflowRow}</table>`;
  }).join("");

  const bodyContent = days.length
    ? dayBlocks
    : `<p style="padding:0 24px;font-family:-apple-system,sans-serif;color:#8a7a63;">No events loaded for this week yet \u2014 check the app directly.</p>`;

  return `
  <div style="max-width:600px;margin:0 auto;background:#FBF6EC;font-family:-apple-system,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr><td background="${DIGEST_SITE_URL}/hero-flatirons.jpg" style="background-image:url('${DIGEST_SITE_URL}/hero-flatirons.jpg');background-size:cover;background-position:center 65%;height:150px;" height="150">
        <table role="presentation" width="100%" height="150" cellpadding="0" cellspacing="0"><tr><td valign="bottom" style="padding:16px 24px;background:linear-gradient(180deg,rgba(31,42,34,0.05) 0%,rgba(31,42,34,0.6) 100%);">
          <div style="font-family:Georgia,serif;font-size:24px;font-weight:700;color:#ffffff;">Playroute</div>
        </td></tr></table>
      </td></tr>
    </table>

    <div style="padding:20px 24px 4px;">
      <h1 style="font-family:Georgia,serif;font-size:19px;color:#1F2A22;margin:0 0 6px;">This week on Playroute</h1>
      <p style="font-size:13px;color:#6B7268;margin:0;line-height:1.5;">A quick look at what's coming up for the kids this week.</p>
    </div>
    <div style="padding:0 24px;">${ctaButton("Open Playroute")}</div>

    ${spotlightHtml}
    <p style="padding:18px 24px 4px;margin:0;font-size:11px;font-weight:700;letter-spacing:0.09em;text-transform:uppercase;color:#3C5548;font-family:-apple-system,sans-serif;">This week, day by day</p>
    ${bodyContent}

    <div style="padding:20px 24px 4px;">${ctaButton("See the full week")}</div>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:18px 24px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px dashed #D3D8C8;border-radius:12px;"><tr><td align="center" style="padding:13px;font-family:-apple-system,sans-serif;font-size:12.5px;color:#6B7268;">
        <span style="font-family:Georgia,serif;font-size:15px;color:#A8623A;font-weight:700;">${eventsDiscovered.toLocaleString()}</span> events discovered through Playroute so far
      </td></tr></table>
    </td></tr></table>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:0 24px 18px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F1E7D2;border-radius:12px;"><tr>
        <td align="center" style="padding:14px 16px;font-family:-apple-system,sans-serif;font-size:12.5px;color:#6B7268;">
          <span style="font-size:13px;">\uD83D\uDC55 We love <a href="https://bestdayeverkids.com?sca_ref=11971740.LIQBY7i7kE" style="color:#A8623A;font-weight:700;text-decoration:none;" target="_blank" rel="noopener noreferrer sponsored">Best Day Ever Kids'</a> clothes for adventure-ready kids <span style="color:#a89478;">(affiliate link)</span></span>
        </td>
      </tr></table>
    </td></tr></table>

    <p style="text-align:center;font-size:11px;color:#b5a88f;font-family:-apple-system,sans-serif;padding-bottom:20px;">You're getting this because you subscribed to Playroute's weekly digest. <a href="${unsubscribeUrl}" style="color:#b5a88f;">Unsubscribe</a></p>
  </div>`;
}

function buildDigestText(byDay, spotlight, eventsDiscovered) {
  const lines = ["This week on Playroute", "", `Open Playroute: ${DIGEST_SITE_URL}/?src=newsletter`, ""];

  if (spotlight.length) {
    lines.push("DON'T MISS THESE");
    for (const ev of spotlight) {
      const badge = ev.badge === "trending" ? "[TRENDING] " : ev.badge === "popular" ? "[POPULAR] " : "";
      const cleanSource = cleanSourceForDisplay(ev.source);
      lines.push(`- ${badge}${ev.title} \u2014 ${cleanSource}${cleanSource ? ", " : ""}${ev.city} \u00B7 ${ev.occurrence_label}, ${ev.display_time}`);
    }
    lines.push("");
  }

  for (const [label, { shown, total }] of byDay.entries()) {
    lines.push(label.toUpperCase());
    for (const ev of shown) {
      const badge = ev.badge === "trending" ? "[TRENDING] " : ev.badge === "popular" ? "[POPULAR] " : ev.is_new ? "[NEW] " : "";
      const cleanSource = cleanSourceForDisplay(ev.source);
      const location = cleanSource ? `${cleanSource}, ` : "";
      lines.push(`- ${badge}${ev.title} \u2014 ${ev.display_time} \u00B7 ${location}${ev.city} \u00B7 ${ev.cost === "free" ? "Free" : "Paid"}`);
    }
    const overflow = total - shown.length;
    if (overflow > 0) {
      lines.push(`+ ${overflow} more event${overflow === 1 ? "" : "s"} on Playroute: ${DIGEST_SITE_URL}/?src=newsletter`);
    }
    lines.push("");
  }
  lines.push(`${eventsDiscovered.toLocaleString()} events discovered through Playroute so far`);
  lines.push("");
  lines.push(`We love Best Day Ever Kids' clothes for adventure-ready kids (affiliate link): https://bestdayeverkids.com?sca_ref=11971740.LIQBY7i7kE`);
  lines.push("");
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

// ---------------------------------------------------------------------
// WEEKLY ENGAGEMENT DIGEST — separate from the subscriber email digest
// above. Scores each event's link_clicks (views/calendar-adds/shares) for
// the trailing 7 days into engagement_digests, then assigns a badge:
//   'trending' — this week's total is >=1.5x that event's own prior
//                3-week average, with a floor of 5 interactions so a
//                1->2 click jump doesn't get flagged
//   'popular'  — top ~12% by raw volume this week, regardless of trend
// Runs off the same Sunday cron as the subscriber digest (see scheduled()
// below). handleEvents() reads the latest week's badges and attaches them
// to the /api/events response for the frontend to render.
// ---------------------------------------------------------------------
// Checks already-PUBLISHED events against their source, looking for
// cancellations or time changes -- different from every other function in
// this file, which only looks for NEW candidates. Reuses pending_events
// (via the change_type/existing_event_id columns) rather than a separate
// admin dialog: same approve/reject tokens, same weekly review email, same
// one-tap UI. Only works for events with a source_id (added 2026-08-21) --
// events approved before that column existed have no link back to verify
// against, so this only covers sources built after that point (starting
// with Anythink Thornton) until/unless older approved events get backfilled
// with a source_id some other way.
async function queueChangeCandidate(env, ev) {
  await env.DB.prepare(
    `INSERT INTO pending_events
      (title, source, city, category, cost, age_min, age_max, day_of_week,
       event_date, start_time, display_time, recurrence, note, source_url,
       raw_excerpt, dedup_key, approval_token, severity, validation_notes,
       source_id, change_type, existing_event_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'review', '[]', ?, ?, ?)
     ON CONFLICT(dedup_key) DO NOTHING`
  ).bind(
    ev.title, ev.source, ev.city, ev.category, ev.cost, ev.age_min, ev.age_max,
    ev.day_of_week, ev.event_date, ev.start_time, ev.display_time, ev.recurrence,
    ev.note, ev.source_url, ev.note, ev.dedup_key, crypto.randomUUID(),
    ev.source_id, ev.change_type, ev.existing_event_id
  ).run();
}

async function runSourceVerification(env) {
  const { results: sources } = await env.DB.prepare(
    `SELECT * FROM scrape_sources WHERE mode = 'auto' AND enabled = 1`
  ).all();

  let totalFlagged = 0;
  const errors = [];

  for (const source of sources) {
    const runner = SOURCE_RUNNERS[source.source_key];
    if (!runner) continue;

    // Only bother re-fetching a source's feed if anything is actually
    // linked to it -- most auto sources feed the review queue directly and
    // nothing gets approved from them with a source_id carried through
    // until a human approves it, so this naturally stays cheap.
    const { results: linkedEvents } = await env.DB.prepare(
      `SELECT * FROM events WHERE source_id = ? AND ((recurrence = 'dated' AND event_date >= date('now')) OR recurrence = 'weekly')`
    ).bind(source.id).all();
    if (linkedEvents.length === 0) continue;

    let freshCandidates;
    try {
      freshCandidates = await runner();
    } catch (err) {
      // A fetch failure must NOT be treated as "everything got cancelled"
      // -- that would turn a temporary site outage into dozens of false
      // cancellation flags. Skip verifying this source for this run and
      // move on; the next weekly run tries again.
      errors.push({ source: source.source_key, error: String(err) });
      continue;
    }

    for (const existing of linkedEvents) {
      const match = freshCandidates.find((c) =>
        c.title === existing.title &&
        (existing.recurrence === "dated" ? c.event_date === existing.event_date : c.day_of_week === existing.day_of_week)
      );

      if (!match) {
        // Skip if there's already an unresolved flag for this exact event
        // -- don't clutter the queue with a second copy of the same
        // question while the first is still sitting there. Once resolved
        // (approved or rejected either way), this check no longer blocks
        // it, so a later run can flag it again if the condition recurs.
        const alreadyFlagged = await env.DB.prepare(
          `SELECT 1 FROM pending_events WHERE existing_event_id = ? AND change_type = 'cancelled' AND status = 'pending'`
        ).bind(existing.id).first();
        if (alreadyFlagged) continue;
        await queueChangeCandidate(env, {
          change_type: "cancelled",
          existing_event_id: existing.id,
          title: `\u26A0\uFE0F Possibly cancelled: ${existing.title}`,
          source: existing.source, city: existing.city, category: existing.category,
          cost: existing.cost, age_min: existing.age_min, age_max: existing.age_max,
          day_of_week: existing.day_of_week, event_date: existing.event_date,
          start_time: existing.start_time, display_time: existing.display_time,
          recurrence: existing.recurrence,
          note: `No longer appears in ${source.platform}'s current listing as of this week's check. Could be a real cancellation, or the source just changed how it's listed -- confirm before approving (approving removes it from Playroute).`,
          source_url: existing.source_url,
          // Includes today's date, not just the event id -- a dedup_key
          // with no time component would permanently block ever flagging
          // this same event again once this row is resolved (rejected as
          // a false alarm, or approved), even if it genuinely gets
          // cancelled for real weeks later. The "already flagged" check
          // above is what prevents duplicate clutter while unresolved;
          // this is what prevents a stale key from blocking it forever.
          dedup_key: `verify-cancelled:${existing.id}:${mtCalendarDateStr(new Date())}`,
          source_id: source.id
        });
        totalFlagged++;
        continue;
      }

      const timeChanged = match.start_time !== existing.start_time ||
        (existing.recurrence === "weekly" && match.day_of_week !== existing.day_of_week) ||
        (existing.recurrence === "dated" && match.event_date !== existing.event_date);
      if (timeChanged) {
        const alreadyFlagged = await env.DB.prepare(
          `SELECT 1 FROM pending_events WHERE existing_event_id = ? AND change_type = 'time_changed' AND status = 'pending'`
        ).bind(existing.id).first();
        if (alreadyFlagged) continue;
        await queueChangeCandidate(env, {
          change_type: "time_changed",
          existing_event_id: existing.id,
          title: `\u26A0\uFE0F Time changed: ${existing.title}`,
          source: existing.source, city: existing.city, category: existing.category,
          cost: existing.cost, age_min: existing.age_min, age_max: existing.age_max,
          day_of_week: match.day_of_week, event_date: match.event_date,
          start_time: match.start_time, display_time: match.display_time,
          recurrence: existing.recurrence,
          note: `Currently on Playroute as ${existing.display_time}${existing.day_of_week ? " " + existing.day_of_week : ""}. The source now shows ${match.display_time}${match.day_of_week ? " " + match.day_of_week : ""} instead. Approving updates the live event to this new time.`,
          source_url: existing.source_url,
          dedup_key: `verify-timechange:${existing.id}:${match.start_time}:${match.day_of_week || match.event_date}:${mtCalendarDateStr(new Date())}`,
          source_id: source.id
        });
        totalFlagged++;
      }
    }
  }

  await env.DB.prepare(`INSERT INTO job_runs (job_name, status, details) VALUES (?, 'success', ?)`)
    .bind("source_verification", JSON.stringify({ sourcesChecked: sources.length, totalFlagged, errors })).run();

  return { sourcesChecked: sources.length, totalFlagged, errors };
}

async function runWeeklyEngagementDigest(env) {
  // INSERT OR REPLACE relies on idx_engagement_digest_unique (event_id,
  // event_title, week_start) -- without it, re-running this job for a week
  // that's already been scored (e.g. a manual re-trigger, or the cron
  // firing twice) silently piled up duplicate rows instead of updating in
  // place. Safe to replace-on-conflict here even though this INSERT leaves
  // prior_avg_interactions/trend_ratio/badge as NULL: the three UPDATE
  // statements right below unconditionally recompute those for the whole
  // week regardless of whether this was an insert or a replace.
  await env.DB.prepare(
    `INSERT OR REPLACE INTO engagement_digests
      (event_id, event_title, event_category, event_city,
       week_start, week_end, views, calendar_adds, shares, source_clicks,
       total_interactions, prior_avg_interactions, trend_ratio, badge)
     SELECT
       lc.event_id, lc.event_title, e.category, e.city,
       date('now','-7 days'), date('now'),
       SUM(CASE WHEN lc.action_type='view_details' THEN 1 ELSE 0 END),
       SUM(CASE WHEN lc.action_type='add_to_calendar' THEN 1 ELSE 0 END),
       SUM(CASE WHEN lc.action_type='share' THEN 1 ELSE 0 END),
       SUM(CASE WHEN lc.action_type='source_click' THEN 1 ELSE 0 END),
       COUNT(*), NULL, NULL, NULL
     FROM link_clicks lc
     INNER JOIN events e ON e.id = lc.event_id
     WHERE lc.clicked_at >= datetime('now','-7 days')
     GROUP BY lc.event_id, lc.event_title`
  ).run();

  await env.DB.prepare(
    `UPDATE engagement_digests
     SET prior_avg_interactions = (
       SELECT AVG(total_interactions) FROM engagement_digests prev
       WHERE prev.event_id = engagement_digests.event_id
         AND prev.week_start < date('now','-7 days')
         AND prev.week_start >= date('now','-28 days')
     )
     WHERE week_start = date('now','-7 days')`
  ).run();

  await env.DB.prepare(
    `UPDATE engagement_digests
     SET trend_ratio = CASE WHEN prior_avg_interactions > 0
           THEN CAST(total_interactions AS REAL) / prior_avg_interactions ELSE NULL END
     WHERE week_start = date('now','-7 days')`
  ).run();

  // Popular badge, two tiers. Tier 1 (core coverage cities): percentile
  // computed against ONLY that city's own events -- without this,
  // Boulder/Longmont's much higher raw volume structurally crowded out
  // every other city (verified against real data: the old global-only
  // version gave zero 'popular' badges to Westminster, Lyons, Arvada, or
  // Superior despite real scored activity in each). Tier 2 (everywhere
  // else): incidental one-off cities fall back to the old global
  // percentile rather than getting their own slot -- simulated first, and
  // giving every city its own tier meant a city with one random event
  // auto-qualified just for being the only thing that happened there that
  // week, which is noise, not signal. Both tiers require >=3
  // total_interactions -- 'popular' previously had no absolute floor.
  const CORE_CITIES = ["Boulder","Longmont","Erie","Lafayette","Louisville","Westminster","Superior","Broomfield","Arvada"];
  const coreCitiesSql = CORE_CITIES.map((c) => `'${c}'`).join(",");
  // UPDATE...FROM with preceding CTEs, not nested correlated subqueries --
  // an earlier version of this used subqueries nested inside an OFFSET
  // clause (matching the original single-tier code this replaced), and it
  // was NEVER ACTUALLY TESTED against real D1 before being written. It was
  // caught here, before shipping: D1's SQLite does not support that depth
  // of correlation and throws "no such column" on both a SELECT and an
  // UPDATE using that shape. This CTE + UPDATE...FROM version was verified
  // working directly against production data before being put here.
  await env.DB.prepare(
    `WITH city_ranked AS (
       SELECT id,
         ROW_NUMBER() OVER (PARTITION BY event_city ORDER BY total_interactions DESC) as city_rnk,
         COUNT(*) OVER (PARTITION BY event_city) as city_n
       FROM engagement_digests WHERE week_start = date('now','-7 days')
     ),
     global_ranked AS (
       SELECT id,
         ROW_NUMBER() OVER (ORDER BY total_interactions DESC) as g_rnk,
         COUNT(*) OVER () as g_n
       FROM engagement_digests WHERE week_start = date('now','-7 days')
     )
     UPDATE engagement_digests
     SET badge = CASE
       WHEN trend_ratio >= 1.5 AND total_interactions >= 5 THEN 'trending'
       WHEN event_city IN (${coreCitiesSql})
         AND total_interactions >= 3
         AND cr.city_rnk <= CAST(cr.city_n * 0.12 AS INTEGER) + 1
       THEN 'popular'
       WHEN event_city NOT IN (${coreCitiesSql})
         AND total_interactions >= 3
         AND gr.g_rnk <= CAST(gr.g_n * 0.12 AS INTEGER) + 1
       THEN 'popular'
       ELSE NULL
     END
     FROM city_ranked cr, global_ranked gr
     WHERE engagement_digests.id = cr.id
       AND engagement_digests.id = gr.id
       AND engagement_digests.week_start = date('now','-7 days')`
  ).run();

  const scored = await env.DB.prepare(`SELECT COUNT(*) n FROM engagement_digests WHERE week_start = date('now','-7 days')`).first();
  const trending = await env.DB.prepare(`SELECT COUNT(*) n FROM engagement_digests WHERE week_start = date('now','-7 days') AND badge='trending'`).first();
  const popular = await env.DB.prepare(`SELECT COUNT(*) n FROM engagement_digests WHERE week_start = date('now','-7 days') AND badge='popular'`).first();

  await env.DB.prepare(`INSERT INTO job_runs (job_name, status, details) VALUES (?, 'success', ?)`)
    .bind("weekly_engagement_digest", JSON.stringify({
      week_start: "last 7 days", events_scored: scored.n, trending_count: trending.n, popular_count: popular.n
    })).run();

  return { events_scored: scored.n, trending_count: trending.n, popular_count: popular.n };
}

async function runWeeklyDigest(env, testEmail = null) {
  const { byDay, spotlight, eventsDiscovered, weekLabel } = await getWeekAheadEvents(env);
  const subject = `This week on Playroute \uD83C\uDF33 \u2014 ${weekLabel}`;

  if (testEmail) {
    // Test mode: send to exactly one address, real content, without
    // touching the subscribers table or anyone's real subscription at all.
    // Subject includes a time marker (not just the week range) since test
    // sends commonly get repeated several times within the same hour while
    // debugging -- without it, Gmail would still thread those together.
    const timeMarker = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ });
    const unsubscribeUrl = `${DIGEST_SITE_URL}/api/unsubscribe?email=${encodeURIComponent(testEmail)}`;
    const html = buildDigestHtml(byDay, spotlight, eventsDiscovered, unsubscribeUrl);
    const text = buildDigestText(byDay, spotlight, eventsDiscovered);
    try {
      await sendDigestEmail(env, testEmail, html, text, `[TEST ${timeMarker}] ${subject}`);
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
    const html = buildDigestHtml(byDay, spotlight, eventsDiscovered, unsubscribeUrl);
    const text = buildDigestText(byDay, spotlight, eventsDiscovered);
    try {
      await sendDigestEmail(env, email, html, text, subject);
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

// Decoupled from any specific scan — call this after any runSources() run
// (daily, weekly, monthly, or the admin panel's "run everything" button) to
// notify you if anything new is sitting in the review queue. Only emails if
// there's something to actually review, no empty "nothing found" noise.
async function emailPendingReviewIfAny(env) {
  const { results: pending } = await env.DB.prepare(
    `SELECT * FROM pending_events WHERE status = 'pending' ORDER BY discovered_at DESC`
  ).all();
  if (pending.length === 0 || !env.ADMIN_EMAIL) return { sent: false, count: pending.length };
  const html = buildPendingEventsEmailHtml(pending);
  // Includes the count so the subject varies run to run -- otherwise this
  // fires every time new events are scraped with an identical subject line,
  // and Gmail threads same-subject emails together, collapsing everything
  // but the latest run behind "Show trimmed content." The count is also
  // just more useful to see at a glance in an inbox list.
  await sendDigestEmail(env, env.ADMIN_EMAIL, html, null, `${pending.length} new event${pending.length === 1 ? "" : "s"} to review on Playroute`);
  return { sent: true, count: pending.length };
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
  if (!token || token === "null" || token === "undefined") {
    return new Response(
      "Missing or invalid approval token — this pending row likely has approval_token = NULL " +
      "(happens if it was inserted directly rather than through ingestCandidate()/the /api/ingest " +
      "pipeline, which always generates one). Nothing was changed. Backfill a token for this row " +
      "before it can be approved or rejected.",
      { status: 400, headers: { "Content-Type": "text/plain" } }
    );
  }
  const row = await env.DB.prepare(`SELECT * FROM pending_events WHERE approval_token = ? AND status = 'pending'`).bind(token).first();
  if (!row) return new Response("This item was already handled or doesn't exist.", { status: 404, headers: { "Content-Type": "text/plain" } });

  // Cancellation / time-change flags take a completely different path than
  // a normal new-event candidate: approving one doesn't INSERT a new row,
  // it acts on the existing live event this flag is about. Reuses the same
  // pending_events queue/approve/reject flow rather than a separate admin
  // dialog on purpose -- same tokens, same one-tap approve/reject, same
  // weekly pending-review email, nothing new to learn.
  if (row.change_type === "cancelled") {
    if (!row.existing_event_id) {
      return new Response("This cancellation flag is missing its target event id -- can't act on it safely. Reject it instead.", { status: 422, headers: { "Content-Type": "text/plain" } });
    }
    await env.DB.prepare(`DELETE FROM events WHERE id = ?`).bind(row.existing_event_id).run();
    await env.DB.prepare(`UPDATE pending_events SET status = 'approved', decided_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(row.id).run();
    return new Response(`Removed "${row.title.replace(/^\u26A0\uFE0F Possibly cancelled: /, "")}" from Playroute.`, { headers: { "Content-Type": "text/plain" } });
  }
  if (row.change_type === "time_changed") {
    if (!row.existing_event_id) {
      return new Response("This time-change flag is missing its target event id -- can't act on it safely. Reject it instead.", { status: 422, headers: { "Content-Type": "text/plain" } });
    }
    await env.DB.prepare(
      `UPDATE events SET start_time = ?, day_of_week = ?, event_date = ?, display_time = ?, last_scraped_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).bind(row.start_time, row.day_of_week, row.event_date, row.display_time, row.existing_event_id).run();
    await env.DB.prepare(`UPDATE pending_events SET status = 'approved', decided_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(row.id).run();
    return new Response(`Updated "${row.title.replace(/^\u26A0\uFE0F Time changed: /, "")}" to its new time on Playroute.`, { headers: { "Content-Type": "text/plain" } });
  }

  // Re-validate server-side rather than trusting whatever severity was
  // stamped when this was first queued — a stale/tampered token shouldn't
  // be able to skip this check. This is also where the old code used to
  // silently fill in guessed defaults (category||"outdoor", cost||"free",
  // age_min??0, recurrence||"dated") for anything missing — exactly the
  // "Westminster queues start_time: null and nothing flags it before you
  // approve it live" problem. No more silent fallbacks: if it's missing
  // something required, you get told, not a guessed value.
  const candidate = {
    title: row.title, source: row.source, city: row.city, category: row.category,
    cost: row.cost, age_min: row.age_min, age_max: row.age_max, day_of_week: row.day_of_week,
    start_time: row.start_time, display_time: row.display_time, recurrence: row.recurrence,
    event_date: row.event_date, note: row.note, source_url: row.source_url
  };
  const { severity, issues } = validateCandidate(candidate);
  if (severity === "error") {
    const reasons = issues.filter(i => i.level === "error").map(i => `- ${i.reason}`).join("\n");
    return new Response(
      `Can't approve "${row.title}" yet — it's missing information a real event needs:\n\n${reasons}\n\nEdit the row directly in D1 (or reject it) rather than publishing something incomplete.`,
      { status: 422, headers: { "Content-Type": "text/plain" } }
    );
  }

  try {
    await upsertEvent(env, {
      title: row.title,
      source: row.source,
      city: row.city,
      category: row.category,
      cost: row.cost,
      age_min: row.age_min,
      age_max: row.age_max,
      day_of_week: row.day_of_week,
      start_time: row.start_time,
      display_time: row.display_time,
      recurrence: row.recurrence,
      event_date: row.event_date,
      note: row.note,
      source_url: row.source_url,
      verified: 0,
      libcal_event_id: row.dedup_key,
      source_id: row.source_id ?? null
    });
  } catch (err) {
    // Belt-and-suspenders: upsertEvent's two chained ON CONFLICT clauses
    // (2026-07-14 fix) should already handle both real unique constraints
    // on `events` gracefully, but if some future schema change introduces
    // a third one, fail with something you can actually act on instead of
    // a raw D1 error.
    return new Response(
      `Couldn't publish "${row.title}" — the database rejected it: ${String(err)}\n\nThis pending item is still sitting in the queue, untouched, so nothing was lost. Worth flagging if you see this.`,
      { status: 500, headers: { "Content-Type": "text/plain" } }
    );
  }
  await env.DB.prepare(`UPDATE pending_events SET status = 'approved', decided_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(row.id).run();
  const warnings = issues.filter(i => i.level === "warn");
  const warnNote = warnings.length ? ` (heads up: ${warnings.map(w => w.reason).join("; ")})` : "";
  return new Response(`"${row.title}" has been added to Playroute. Thanks for reviewing!${warnNote}`, { headers: { "Content-Type": "text/plain" } });
}

async function handleRejectPending(env, url) {
  const token = url.searchParams.get("token");
  if (!token || token === "null" || token === "undefined") {
    return new Response(
      "Missing or invalid approval token — this pending row likely has approval_token = NULL. " +
      "Nothing was changed. Backfill a token for this row before it can be approved or rejected.",
      { status: 400, headers: { "Content-Type": "text/plain" } }
    );
  }
  const res = await env.DB.prepare(`UPDATE pending_events SET status = 'rejected', decided_at = CURRENT_TIMESTAMP WHERE approval_token = ? AND status = 'pending'`).bind(token).run();
  if (res.meta.changes === 0) return new Response("This item was already handled or doesn't exist.", { status: 404, headers: { "Content-Type": "text/plain" } });
  return new Response("Got it — dismissed and won't be suggested again.", { headers: { "Content-Type": "text/plain" } });
}

// JSON list for admin.html's "Pending events" card -- same underlying data
// as the email digest (buildPendingEventsEmailHtml), just queryable on
// demand instead of only arriving Sunday at noon or after a manual scan.
async function handlePendingEventsList(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, title, source, city, category, cost, age_min, age_max, day_of_week,
            event_date, start_time, display_time, note, source_url, dedup_key,
            approval_token, discovered_at, severity, validation_notes,
            change_type, existing_event_id
     FROM pending_events WHERE status = 'pending'
     ORDER BY CASE WHEN change_type IS NOT NULL THEN 0 ELSE 1 END,
              CASE severity WHEN 'error' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, discovered_at DESC`
  ).all();
  return json({ count: results.length, pending: results });
}

// Self-service answer to "how do I know the pending queue doesn't already
// duplicate something live?" -- cross-checks every current pending item
// against `events` using the same title+city+day-or-date+source identity
// checkDuplicateRisk uses at ingest time. Two buckets:
//   exact: same time too -- an unambiguous duplicate, safe to bulk-reject
//   time_conflict: same everything except time -- needs a look (could be
//     a real schedule change, or a leftover artifact like the ones found
//     2026-07-17) rather than being auto-resolved either direction
async function handleCheckPendingDuplicates(env) {
  const { results } = await env.DB.prepare(`
    SELECT p.id as pending_id, p.title, p.city, p.event_date, p.day_of_week,
           p.start_time as pending_time, p.source, p.approval_token,
           e.id as live_event_id, e.start_time as live_time
    FROM pending_events p
    JOIN events e ON p.title = e.title AND p.city = e.city AND p.source = e.source
      AND (
        (p.event_date IS NOT NULL AND p.event_date = e.event_date)
        OR (p.event_date IS NULL AND p.day_of_week = e.day_of_week)
      )
    WHERE p.status = 'pending'
    ORDER BY p.title
  `).all();

  const exact = results.filter(r => r.pending_time === r.live_time);
  const timeConflict = results.filter(r => r.pending_time !== r.live_time);
  return json({
    checked_at: new Date().toISOString(),
    exact_duplicates: exact,
    time_conflicts: timeConflict,
    summary: `${exact.length} exact duplicate(s) already live, ${timeConflict.length} same-slot-different-time conflict(s) needing a look`
  });
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

// No auth on this, matching the rest of admin.html (README already accepts
// that risk for a solo pilot). Accepts multipart/form-data with fields
// `park_id` (playgrounds.id) and `file` (image), uploads to the PHOTOS R2
// bucket under a slugified-name key matching the existing image_key
// convention (e.g. "scott-carpenter-park.jpg"), and updates playgrounds.image_key.
async function handlePhotoUpload(request, env) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "Expected multipart/form-data body" }, 400);
  }

  const parkId = form.get("park_id");
  const file = form.get("file");

  if (!parkId) return json({ error: "park_id is required" }, 400);
  if (!(file instanceof File)) return json({ error: "file is required" }, 400);

  const ALLOWED_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
  const ext = ALLOWED_TYPES[file.type];
  if (!ext) {
    return json({ error: `Unsupported file type: ${file.type || "unknown"} — use JPEG, PNG, or WebP` }, 400);
  }

  const MAX_BYTES = 8 * 1024 * 1024; // 8MB
  if (file.size > MAX_BYTES) {
    return json({ error: `File too large (${(file.size / 1024 / 1024).toFixed(1)}MB) — 8MB max` }, 400);
  }

  const playground = await env.DB.prepare(
    "SELECT id, name, image_key FROM playgrounds WHERE id = ?"
  ).bind(parkId).first();
  if (!playground) return json({ error: `No playground found with id ${parkId}` }, 404);

  const slug = playground.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const key = `${slug}.${ext}`;

  await env.PHOTOS.put(key, file, { httpMetadata: { contentType: file.type } });

  // Avoid leaving an orphaned object in R2 if the extension changed
  // (e.g. replacing a .jpg with a .png for the same park).
  if (playground.image_key && playground.image_key !== key) {
    await env.PHOTOS.delete(playground.image_key).catch(() => {});
  }

  await env.DB.prepare("UPDATE playgrounds SET image_key = ? WHERE id = ?").bind(key, parkId).run();

  return json({
    ok: true,
    park_id: Number(parkId),
    park_name: playground.name,
    key,
    url: `/api/photos/${encodeURIComponent(key)}`,
    replaced_existing: !!playground.image_key
  });
}

export default {
  // Cron Trigger entry point — configured in wrangler.jsonc
  async scheduled(event, env, ctx) {
    if (event.cron === "0 18 * * 7" || event.cron === "0 19 * * 7") {
      if (isNearNoonMountain(new Date())) {
        // Sequenced on purpose: runWeeklyDigest reads engagement_digests to
        // attach trending/popular badges to the newsletter, so the badge
        // scoring MUST finish writing this week's rows first. These used to
        // fire as two independent ctx.waitUntil() calls -- which run
        // concurrently, not in order -- so the newsletter could (and did)
        // sometimes build against last week's badges, or none at all, if it
        // happened to finish first. Awaiting the chain forces the order.
        ctx.waitUntil(
          runWeeklyEngagementDigest(env).then(() => runWeeklyDigest(env))
        );
        ctx.waitUntil(
          runSources(env, { cadence: "weekly" })
            .then(() => runSourceVerification(env))
            .then(() => emailPendingReviewIfAny(env))
        );
      }
      return;
    }
    if (event.cron === "0 9 1 * *") {
      // Monthly — My Nature Lab posts topics in ~4-week batches, so a daily
      // check would just be re-scanning the same page for nothing. This
      // trigger previously existed in code but was never actually
      // registered in wrangler.jsonc, so it had never fired — fixed
      // alongside this redesign.
      ctx.waitUntil(runSources(env, { cadence: "monthly" }).then(() => emailPendingReviewIfAny(env)));
      return;
    }
    ctx.waitUntil(runSources(env, { cadence: "daily" }).then(() => emailPendingReviewIfAny(env)));
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
      if (url.pathname === "/api/photos/upload" && request.method === "POST") {
        return await handlePhotoUpload(request, env);
      }
      if (url.pathname.startsWith("/api/photos/")) {
        return await handlePhoto(env, decodeURIComponent(url.pathname.slice("/api/photos/".length)));
      }
      if (url.pathname === "/api/track-click" && request.method === "POST") return await handleTrackClick(request, env);
      if (url.pathname === "/api/track-search" && request.method === "POST") return await handleTrackSearch(request, env);
      if (url.pathname === "/api/search-insights" && request.method === "GET") return await handleSearchInsights(env);
      if (url.pathname === "/api/pageview" && request.method === "POST") return await handlePageView(request, env);
      if (url.pathname === "/api/stats") return await handleStats(env);
      if (url.pathname === "/api/coverage-alerts") return await handleCoverageAlerts(env);
      if (url.pathname === "/api/referrals-trend") {
        return json(await getReferralsTrend(env, Number(url.searchParams.get("weeks")) || 8));
      }
      if (url.pathname === "/api/wau-trend") {
        const weeks = Math.min(Math.max(parseInt(url.searchParams.get("weeks")) || 12, 1), 26);
        const trend = await getWauTrend(env, weeks);
        return json({ weeks, trend });
      }
      if (url.pathname === "/api/public-stats") {
        const row = await env.DB.prepare(
          `SELECT COUNT(*) AS n FROM link_clicks WHERE category NOT IN ('playground','hike','support')`
        ).first();
        return json({ events_discovered_all_time: row?.n || 0 });
      }
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
      // Single run entrypoint, replacing the old /api/scrape-now +
      // /api/pending-scan-now split — everything goes to the review queue
      // now, so there's nothing left to meaningfully split between. Optional
      // ?cadence=daily|weekly|monthly filters; omit it to run everything
      // (that's what the admin panel's one button does).
      if (url.pathname === "/api/run-sources" && request.method === "POST") {
        const cadence = url.searchParams.get("cadence");
        const results = await runSources(env, cadence ? { cadence } : {});
        const emailResult = await emailPendingReviewIfAny(env);
        return json({ ranAt: new Date().toISOString(), cadence: cadence || "all", results, emailResult });
      }
      // Triggers EventDiscoveryWorkflow (see discovery-workflow.js) --
      // unlike /api/run-sources above, this returns almost immediately with
      // just an instance ID. Workflows execute durably in the background,
      // not within this HTTP request's lifetime -- the actual discovery
      // (web search + LLM call + queueing) can take a couple of minutes and
      // happens after this response is already sent. Check results via
      // pending_events (?source= one of the llm_discovery_* keys) or the
      // instance status endpoint below, not by waiting on this call.
      // Optional ?city=Boulder forces a specific city instead of the
      // automatic least-recently-run pick.
      if (url.pathname === "/api/run-discovery" && request.method === "POST") {
        const city = url.searchParams.get("city");
        const instance = await env.EVENT_DISCOVERY_WORKFLOW.create(
          city ? { params: { city } } : {}
        );
        return json({ startedAt: new Date().toISOString(), instanceId: instance.id, city: city || "(auto-picked)" });
      }
      if (url.pathname === "/api/discovery-status" && request.method === "GET") {
        const instanceId = url.searchParams.get("id");
        if (!instanceId) return json({ error: "missing ?id=<instanceId>" }, 400);
        const instance = await env.EVENT_DISCOVERY_WORKFLOW.get(instanceId);
        const status = await instance.status();
        return json(status);
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
      if (url.pathname === "/api/engagement-digest-now" && request.method === "POST") {
        const results = await runWeeklyEngagementDigest(env);
        return json({ ranAt: new Date().toISOString(), results });
      }
      if (url.pathname === "/api/approve-pending") {
        return await handleApprovePending(env, url);
      }
      if (url.pathname === "/api/reject-pending") {
        return await handleRejectPending(env, url);
      }
      if (url.pathname === "/api/pending-events" && request.method === "GET") {
        return await handlePendingEventsList(env);
      }
      if (url.pathname === "/api/check-pending-duplicates" && request.method === "GET") {
        return await handleCheckPendingDuplicates(env);
      }
    } catch (err) {
      return errorResponse(err);
    }
    return new Response(
      "Playroute API \u2014 try /api/events, /api/playgrounds, /api/hikes, /api/sources, or POST /api/run-sources[?cadence=daily|weekly|monthly]\n\n/api/events supports ?city=&category=&cost=free&age=0-1.5|2-4|5-8&includeIrregular=1",
      { headers: CORS_HEADERS }
    );
  }
};
