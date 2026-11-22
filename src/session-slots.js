// src/session-slots.js
//
// Some city listings show one wide time window for a program that really
// runs as several short sessions. Longmont Museum's Discovery Days list as
// "9:15 am - 2:15 pm" (Art) or "8 am - 5 pm" (Music & Movement) at the top
// of the page, while the description further down gives the real sessions:
//
//   Wednesdays, Thursdays, Fridays, Saturdays; Classroom AB
//   9:15 am, 10:45 am, 1 pm; 1 hour 15 minutes per session
//
// Published rows hold one event per session (9:15, 10:45, 1:00), so
// comparing them to the wide window made weekly source verification flag
// every session as a "time change" (2026-11-22). These helpers read the
// session list so the scraper emits one candidate per session, and give
// verification a guard for when a wide window is all the feed has.

// "9:15 am", "1 pm", "10:45 a.m." -> minutes after midnight.
export function labelToMinutes(label) {
  const m = String(label || "").match(/(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?/i);
  if (!m) return null;
  let h = +m[1];
  const min = m[2] ? +m[2] : 0;
  if (h > 12 || min > 59) return null;
  const pm = m[3].toLowerCase() === "p";
  if (pm && h !== 12) h += 12;
  if (!pm && h === 12) h = 0;
  return h * 60 + min;
}

export function minutesToHHMM(mins) {
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

// Same style as the Longmont list parser: "9:15 am", "1 pm".
export function minutesToLabel(mins) {
  const h24 = Math.floor(mins / 60), m = mins % 60;
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}${m ? ":" + String(m).padStart(2, "0") : ""} ${h24 < 12 ? "am" : "pm"}`;
}

// "8 am - 5 pm" -> { start: 480, end: 1020 }, or null.
export function parseTimeRange(display) {
  const m = String(display || "").match(/(\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?)\s*[-–—]\s*(\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?)/i);
  if (!m) return null;
  const start = labelToMinutes(m[1]), end = labelToMinutes(m[2]);
  return start == null || end == null || end <= start ? null : { start, end };
}

const TIME = String.raw`\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?`;
// Two or more times joined by commas or "and" -- never a "-" range.
const SLOT_LIST_RE = new RegExp(String.raw`(?<![\d:])${TIME}(?:\s*(?:,|,?\s+and)\s*${TIME})+`, "gi");
const SESSION_LENGTH_RE = /(?:(\d+)\s*hours?)?\s*(?:(\d+)\s*min(?:ute)?s?)?\s*per session/i;

// Reads "<times>; <length> per session" out of a page's plain text.
// Returns { starts: [minutes...], durationMinutes } or null. durationMinutes
// is null when the page gives a range ("45 minutes–1 hour") or nothing.
// Two different session lists on one page is ambiguous, so that's null too.
export function parseSessionSlots(text) {
  const plain = String(text || "").replace(/\s+/g, " ");
  const lists = [...new Set((plain.match(SLOT_LIST_RE) || []).map((s) => s.toLowerCase().replace(/\s+/g, " ").trim()))];
  if (lists.length !== 1) return null;
  const starts = [...lists[0].matchAll(new RegExp(TIME, "gi"))].map((m) => labelToMinutes(m[0]));
  if (starts.length < 2 || starts.some((s) => s == null)) return null;
  for (let i = 1; i < starts.length; i++) if (starts[i] <= starts[i - 1]) return null;

  let durationMinutes = null;
  const listEnd = plain.toLowerCase().indexOf(lists[0]) + lists[0].length;
  const after = plain.slice(listEnd, listEnd + 80);
  const len = after.match(SESSION_LENGTH_RE);
  if (len && (len[1] || len[2])) {
    const upTo = after.slice(0, len.index + len[0].length);
    const isRange = /\d\s*(?:hours?|min\w*)\s*(?:[-–—]|to\b)\s*\d/i.test(upTo);
    if (!isRange) durationMinutes = (+(len[1] || 0)) * 60 + (+(len[2] || 0)) || null;
  }
  return { starts, durationMinutes };
}

// A listing whose window is this long is treated as "open hours", not one
// session, when deciding whether to look for (or trust) session times.
export const WIDE_WINDOW_MINUTES = 180;

export function isWideWindow(candidate) {
  const r = parseTimeRange(candidate && candidate.display_time);
  return !!r && r.end - r.start >= WIDE_WINDOW_MINUTES;
}

// One candidate per session, when the sessions sit inside the listing's own
// window. Otherwise the candidate comes back unchanged.
export function expandToSessions(candidate, slots) {
  const range = parseTimeRange(candidate.display_time);
  if (!slots || !range) return [candidate];
  if (slots.starts.some((s) => s < range.start || s >= range.end)) return [candidate];
  return slots.starts.map((s) => {
    const end = slots.durationMinutes ? s + slots.durationMinutes : null;
    return {
      ...candidate,
      start_time: minutesToHHMM(s),
      display_time: end && end <= 24 * 60 ? `${minutesToLabel(s)} - ${minutesToLabel(end)}` : minutesToLabel(s)
    };
  });
}

// Verification guard. The feed gave one wide listing for this program and
// day (e.g. its session list couldn't be read this week), and the live
// event is one session inside that window, or one of several sessions that
// day. That's the same program, not a time change.
export function wideListingCoversSession(fresh, existing, liveSessionsThatDay = 1) {
  const range = parseTimeRange(fresh && fresh.display_time);
  if (!range || range.end - range.start < WIDE_WINDOW_MINUTES) return false;
  if (liveSessionsThatDay > 1) return true;
  const [h, m] = String(existing && existing.start_time || "").split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return false;
  const s = h * 60 + m;
  return s >= range.start && s < range.end;
}
