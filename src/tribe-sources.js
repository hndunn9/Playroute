// Pure filters and row mappers for WordPress "The Events Calendar" feeds
// (/wp-json/tribe/events/v1/events). Network code stays in index.js; these
// take one event object from the API so node tests can run them on fixtures.
import { cleanEventDescription, decodeEntities, mentionsFee } from "./event-text.js";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function fmtClock(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}

// Shared date/time fields from a tribe event. Null when the event has no
// usable date or is all-day (nothing real to show as a time).
export function tribeTiming(e) {
  if (e.all_day) return null;
  const [date, startClock] = String(e.start_date || "").split(" ");
  const endClock = String(e.end_date || "").split(" ")[1] || "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !/^\d{2}:\d{2}/.test(startClock || "")) return null;
  const start = startClock.slice(0, 5), end = endClock.slice(0, 5);
  return {
    event_date: date,
    day_of_week: DAY_NAMES[new Date(`${date}T12:00:00Z`).getUTCDay()],
    start_time: start,
    display_time: end && end !== start ? `${fmtClock(start)} – ${fmtClock(end)}` : fmtClock(start)
  };
}

export function tribeCategories(e) {
  return (e.categories || []).map((c) => ({ name: decodeEntities(String(c.name || "")), slug: String(c.slug || "") }));
}

// --- Museum of Boulder ----------------------------------------------------
// Kids/family listings only. "Member Exclusive" is dropped as members-only,
// except when the text itself says the public can come (the museum tags
// e.g. Manitas Creativas both ways while its text says "free with admission").
export function museumKeep(e) {
  const cats = tribeCategories(e).map((c) => c.name);
  if (!cats.some((c) => /kids|famil|children/i.test(c))) return false;
  if (cats.some((c) => /member exclusive/i.test(c))) {
    const text = `${e.description || ""} ${e.excerpt || ""}`;
    if (!/drop[- ]?in|free with (museum )?admission|included with admission|open to (the public|all)|pay what you (wish|can)/i.test(text)) return false;
  }
  return true;
}

// Museum descriptions are clearest in `description`; `excerpt` is often a
// clipped copy of the same opening schedule lines.
export function museumNote(e) {
  const title = decodeEntities(String(e.title || "")).trim();
  const full = cleanEventDescription(e.description, { title });
  return full || cleanEventDescription(e.excerpt, { title }) || null;
}

// --- Boulder County Parks & Open Space -------------------------------------
// bouldercounty.gov runs the same plugin. Every parks event carries the
// parent slug parks-open-space; programs are under hikes-and-events and
// ag-heritage-center. Checked 2026-11-22: of 12 events in the next ten weeks,
// the rest were stakeholder/advisory-committee meetings, a seniors-only hike
// and hours-only "Center Open" listings.
export const BC_PARKS_API = "https://bouldercounty.gov/wp-json/tribe/events/v1/events";
const BC_PROGRAM_SLUGS = new Set(["hikes-and-events", "ag-heritage-center", "art", "assay-office-museum"]);
const BC_DROP_TITLE_RE = /\b(meeting|committee|stakeholder|hearing|commission|town hall|seniors?|adults? only|21\+|18\+|work (?:day|project)|weed(?:ing| pull)?|trail (?:maintenance|work|crew)|volunteer (?:training|orientation|work|project)|training|orientation|election|webinar|zoom)(?!\w)/i;
const BC_DROP_TEXT_RE = /\b(adults? only|ages 18 and (?:up|older)|18 and older|21\+|seniors only|for seniors|ages (?:55|60|65)\+?|work project|weed pull|trail maintenance|advisory committee|public comment)(?!\w)/i;
// Below this many characters a cleaned description is just hours or a
// "register here" line -- not worth a listing on its own.
const BC_MIN_NOTE = 60;

export function bcParksKeep(e) {
  const slugs = tribeCategories(e).map((c) => c.slug);
  if (!slugs.some((s) => BC_PROGRAM_SLUGS.has(s))) return false;
  const title = decodeEntities(String(e.title || ""));
  if (BC_DROP_TITLE_RE.test(title)) return false;
  // "Agricultural Heritage Center Open": an hours listing, not a program.
  if (/\b(?:center|museum|office)\s+open$/i.test(title.trim())) return false;
  if (BC_DROP_TEXT_RE.test(`${e.description || ""}`)) return false;
  return true;
}

const BC_CITIES = ["Boulder", "Longmont", "Lafayette", "Louisville", "Lyons", "Nederland", "Superior", "Erie", "Niwot", "Ward", "Jamestown", "Allenspark", "Gold Hill"];

export function mapBcParksEvent(e) {
  if (!bcParksKeep(e)) return null;
  const timing = tribeTiming(e);
  if (!timing) return null;
  const title = decodeEntities(String(e.title || "")).trim();
  if (!title) return null;
  let note = cleanEventDescription(e.description, { title });
  if (note.length < BC_MIN_NOTE) return null;
  const v = e.venue && !Array.isArray(e.venue) ? e.venue : null;
  const venue = v ? decodeEntities(String(v.venue || "")).trim() : "";
  const vCity = v ? String(v.city || "").trim() : "";
  const city = BC_CITIES.find((c) => c.toLowerCase() === vCity.toLowerCase()) || "Boulder";
  const raw = `${e.description || ""}`;
  if (!/regist/i.test(note)) {
    if (/registration (?:is )?required|registration is needed|must register|please register/i.test(raw)) note += " Registration required.";
    else if (/>\s*Register\s*</i.test(raw)) note += " Register ahead."; // county "Register" button, no stated requirement
  }
  const slugs = tribeCategories(e).map((c) => c.slug);
  const museum = slugs.includes("ag-heritage-center") || slugs.includes("assay-office-museum");
  return {
    title,
    source: venue ? `Boulder County Parks & Open Space — ${venue}` : "Boulder County Parks & Open Space",
    city,
    category: museum ? "museum" : "outdoor",
    cost: mentionsFee(`${e.cost || ""} ${raw}`) ? "paid" : "free",
    age_min: 0,
    age_max: 99,
    ...timing,
    recurrence: "dated",
    note, // index.js truncates at a sentence boundary
    source_url: e.url || "https://bouldercounty.gov/events/"
  };
}
