import { validateCandidate, buildStableDedupKey, ingestCandidate, runSources, SOURCE_RUNNERS } from "./pipeline.js";

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
    raw_excerpt: text.slice(0, 400)
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
    details: detailsMatch ? decodeHtmlEntities(detailsMatch[1]).trim().slice(0, 400) : null,
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
        raw_excerpt: m[0].slice(0, 400),
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
    `INSERT INTO page_views (visitor_hash, city, country, region, device_type, source) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(visitorHash, cf.city || null, cf.country || null, cf.regionCode || null, deviceType, source).run();
  return json({ ok: true });
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

  const topEvents = await env.DB.prepare(
    `SELECT event_id, event_title, event_city, event_category, badge, source_clicks, week_start
     FROM engagement_digests
     WHERE week_start = (SELECT MAX(week_start) FROM engagement_digests)
       AND badge IS NOT NULL
     ORDER BY source_clicks DESC
     LIMIT 15`
  ).all();

  // Per-event trend across recent weeks for whatever's currently badged --
  // lets you see e.g. "this one's been climbing 3 weeks straight" instead
  // of just a single-week snapshot.
  const topEventIds = [...new Set((topEvents.results || []).map(e => e.event_id).filter(id => id != null))];
  const eventTrends = {};
  if (topEventIds.length) {
    const placeholders = topEventIds.map(() => "?").join(",");
    const rows = await env.DB.prepare(
      `SELECT event_id, week_start, source_clicks, badge
       FROM engagement_digests
       WHERE event_id IN (${placeholders}) AND week_start >= date('now', ?)
       ORDER BY week_start ASC`
    ).bind(...topEventIds, `-${weeks * 7} days`).all();
    for (const r of (rows.results || [])) {
      (eventTrends[r.event_id] ||= []).push({ week_start: r.week_start, source_clicks: r.source_clicks, badge: r.badge });
    }
  }

  return {
    weekly_trend: weeklyTrend.results || [],
    top_events: (topEvents.results || []).map(e => ({ ...e, trend: eventTrends[e.event_id] || [] }))
  };
}

async function handleStats(env) {
  const todayStart = mountainMidnightTodayUTC();
  const weekStart = mountainMidnightThisWeekUTC();
  const yesterdayStart = mountainMidnightYesterdayUTC();
  const prevWeekStart = mountainMidnightPrevWeekUTC();
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
  const uniqueVisitorsAllTime = await env.DB.prepare(
    `SELECT COUNT(DISTINCT visitor_hash) AS n FROM page_views WHERE country = 'US'`
  ).first();
  const coloradoVisitorsAllTime = await env.DB.prepare(
    `SELECT COUNT(DISTINCT visitor_hash) AS n FROM page_views WHERE country = 'US' AND region = 'CO'`
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
       verified, libcal_event_id, season_start, season_end, last_scraped_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
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

async function getWeekAheadEvents(env) {
  const { results } = await env.DB.prepare("SELECT * FROM events").all();
  const now = new Date();
  const cutoff = new Date(now.getTime() + DIGEST_MAX_DAYS * 864e5);

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
    const occ = getOccurrence(ev, now);
    if (!occ || occ > cutoff) continue;
    withOccurrence.push({ ...ev, occurrence: occ, occurrence_label: formatOccurrenceLabel(occ), badge: badgeByEventId.get(ev.id) || null });
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
    const rows = evs.map((ev) => {
      const badge = ev.badge === "trending"
        ? `<span style="display:inline-block;background:#B23368;color:#fff;font-size:10px;font-weight:700;letter-spacing:0.03em;padding:1px 6px;border-radius:4px;margin-right:6px;">\u{1F525} TRENDING</span>`
        : ev.badge === "popular"
          ? `<span style="display:inline-block;background:#A6791E;color:#fff;font-size:10px;font-weight:700;letter-spacing:0.03em;padding:1px 6px;border-radius:4px;margin-right:6px;">\u2B50 POPULAR</span>`
          : "";
      return `
      <tr>
        <td style="padding:6px 0;font-family:sans-serif;font-size:14px;color:#2c1f14;">
          ${badge}<strong>${escapeHtml(ev.title)}</strong> \u2014 ${escapeHtml(ev.display_time)}<br>
          <span style="color:#8a7a63;font-size:13px;">${escapeHtml(ev.source || "")}${ev.source ? " \u00B7 " : ""}${escapeHtml(ev.city)} \u00B7 ${ev.cost === "free" ? "Free" : "Paid"}</span>
        </td>
      </tr>`;
    }).join("");
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
      <a href="${DIGEST_SITE_URL}/?src=newsletter" style="display:inline-block;background:#2c1f14;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:14px;">Open Playroute \u2192</a>
    </div>
    <p style="font-size:11px;color:#b5a88f;">You're getting this because you subscribed to Playroute's weekly digest. <a href="${unsubscribeUrl}" style="color:#b5a88f;">Unsubscribe</a></p>
  </div>`;
}

function buildDigestText(byDay) {
  const lines = ["This week on Playroute", ""];
  for (const [label, evs] of byDay.entries()) {
    lines.push(label.toUpperCase());
    for (const ev of evs) {
      const badge = ev.badge === "trending" ? "[TRENDING] " : ev.badge === "popular" ? "[POPULAR] " : "";
      const location = ev.source ? `${ev.source}, ` : "";
      lines.push(`- ${badge}${ev.title} \u2014 ${ev.display_time} \u00B7 ${location}${ev.city} \u00B7 ${ev.cost === "free" ? "Free" : "Paid"}`);
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
async function runWeeklyEngagementDigest(env) {
  await env.DB.prepare(
    `INSERT INTO engagement_digests
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
     LEFT JOIN events e ON e.id = lc.event_id
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

  await env.DB.prepare(
    `UPDATE engagement_digests
     SET badge = CASE
       WHEN trend_ratio >= 1.5 AND total_interactions >= 5 THEN 'trending'
       WHEN total_interactions >= (
         SELECT total_interactions FROM engagement_digests
         WHERE week_start = date('now','-7 days')
         ORDER BY total_interactions DESC
         LIMIT 1 OFFSET (SELECT CAST(COUNT(*) * 0.12 AS INTEGER) FROM engagement_digests WHERE week_start = date('now','-7 days'))
       ) THEN 'popular'
       ELSE NULL
     END
     WHERE week_start = date('now','-7 days')`
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
  await sendDigestEmail(env, env.ADMIN_EMAIL, html, null, "New events to review on Playroute");
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
      libcal_event_id: row.dedup_key
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
            approval_token, discovered_at, severity, validation_notes
     FROM pending_events WHERE status = 'pending'
     ORDER BY CASE severity WHEN 'error' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, discovered_at DESC`
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
        ctx.waitUntil(runWeeklyDigest(env));
        ctx.waitUntil(runWeeklyEngagementDigest(env));
        ctx.waitUntil(runSources(env, { cadence: "weekly" }).then(() => emailPendingReviewIfAny(env)));
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
      if (url.pathname === "/api/pageview" && request.method === "POST") return await handlePageView(request, env);
      if (url.pathname === "/api/stats") return await handleStats(env);
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
