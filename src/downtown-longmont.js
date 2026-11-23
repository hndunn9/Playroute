// Downtown Longmont (LDDA) event calendar: downtownlongmont.com/events/calendar.
// Server-rendered list (checked 2026-11-23): one <a href="/do/<slug>"> card per
// occurrence, about three weeks ahead. Inside each card, in order: a category
// ("Events", "Creative District", "Holidays"), the title, the time ("6pm - 8pm",
// "6:30pm", "All Day" or none), the venue, an optional "Creative District
// Event" tag, then the date ("Fri" "4" "Dec", or "Dec 5 — To — Dec 6").
// Each /do/<slug> page has an <h1>, then "Dates and Times", "Location" and
// "Details" sections; "Details" is the organiser's own text.
//
// Most listings are bars and adult classes. A card becomes a candidate only
// on a kid/family/holiday word in its title, and is kept only when its
// Details text (or title) names kids, families, all ages or an age range and
// nothing says 21+ / adults only. Pure functions here so node tests can run
// them on fixtures; network code is in index.js.
import { cleanEventDescription, decodeEntities, mentionsFee } from "./event-text.js";

export const DL_CALENDAR_URL = "https://www.downtownlongmont.com/events/calendar?d=next30";
export const DL_SITE = "https://www.downtownlongmont.com";

// Venues another Playroute runner already reads directly (longmont_museum,
// longmont_library). Their copies here would only be duplicates.
const DL_COVERED_VENUE_RE = /^(?:longmont museum|longmont public library)\b/i;

const KID_WORDS = "kids?|kiddos?|child(?:ren)?|famil(?:y|ies)|all[- ]ages|toddlers?|bab(?:y|ies)|preschool(?:ers?)?|little ones|youth|tweens?|storytimes?|story time|santa|nutcracker|puppets?|lego|jr\\.?|junior";
const DL_KID_RE = new RegExp(`\\b(?:${KID_WORDS})(?!\\w)`, "i");
// Title words worth opening the event page for: things families go to
// downtown even when the title doesn't say "kids".
const DL_HINT_RE = /\b(?:crafts?|workshop|class|ornaments?|parade|ice show|toys?|cookie|holiday show|pageant|tea party|theat(?:er|re)|musical|pottery|paint(?:ed|ing)?|markets?|tree lighting|festival|fair|carnival|magic|letters)\b/i;
// Alcohol and adult-night listings, dropped before any page fetch.
const DL_ADULT_TITLE_RE = /\b(?:beers?|wine|mimosas?|bellinis?|cocktails?|bottle|brew(?:ing|ery)?|distill\w*|cidery|karaoke|trivia|tarot|date night|life drawing|tango|comedy|open mic|book club|poetry|jazz|repeal|headshots|pilates|happy hour|bubbles|bloody|tapas|game night|dance party|guild|vinyl|21\+)(?!\w)/i;
// In the Details text: the event isn't for children.
const DL_ADULT_TEXT_RE = /(?:\b21\+|\b21 and (?:over|older|up)\b|\b18\+|\badults? only\b|\bages? (?:1[3-9]|[2-9]\d) ?(?:\+|and (?:up|older)))/i;
const DL_AGE_TEXT_RE = /\bages?\s*\d|\b\d{1,2}\s*[-–]\s*\d{1,2}\s*(?:years?|yrs?)\b/i;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const TIME_LINE_RE = /^(\d{1,2})(?::(\d{2}))?\s*([ap])m(?:\s*[-–]\s*(\d{1,2})(?::(\d{2}))?\s*([ap])m)?$/i;

function cardLines(inner) {
  return decodeEntities(String(inner).replace(/<[^>]+>/g, "\n"))
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => /[\p{L}\p{N}]/u.test(l)); // drop icon-font glyph lines
}

function clock(h, m, ap) {
  let hh = Number(h) % 12;
  if (ap.toLowerCase() === "p") hh += 12;
  return { hhmm: `${String(hh).padStart(2, "0")}:${m || "00"}`, label: `${((hh + 11) % 12) + 1}:${m || "00"} ${hh >= 12 ? "PM" : "AM"}` };
}

// "Fri 4 Dec" (badge) or "Dec 5 — To — Dec 6" (range; first day) -> YYYY-MM-DD.
// The cards carry no year: a month more than two behind today's is next year.
function cardDate(rest, today) {
  const t = rest.join(" ");
  let mon, day;
  let m = t.match(/\b(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\s+(\d{1,2})\s+([a-z]{3})[a-z]*\b/i);
  if (m) { day = m[1]; mon = m[2]; }
  else if ((m = t.match(/\b([a-z]{3})[a-z]*\s+(\d{1,2})\s*[—–-]+\s*to\b/i))) { mon = m[1]; day = m[2]; }
  else return null;
  const mi = MONTHS.indexOf(mon.toLowerCase());
  if (mi < 0) return null;
  const [ty, tm] = today.split("-").map(Number);
  const year = mi + 1 < tm - 2 ? ty + 1 : ty;
  return `${year}-${String(mi + 1).padStart(2, "0")}-${String(Number(day)).padStart(2, "0")}`;
}

// Every occurrence card on the calendar page.
export function parseDlCards(html, today) {
  const cards = [];
  const re = /<a\b[^>]*?href\s*=\s*["']((?:https?:\/\/(?:www\.)?downtownlongmont\.com)?\/do\/[\w-]+)\/?["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const lines = cardLines(m[2]);
    if (lines.length < 3) continue;
    const [category, title, ...rest] = lines;
    const date = cardDate(rest, today);
    if (!date) continue;
    const timeLine = rest.find((l) => TIME_LINE_RE.test(l));
    const allDay = rest.some((l) => /^all day$/i.test(l));
    const venue = rest.find((l) => l !== timeLine && !/^all day$/i.test(l) && !/^creative district event$/i.test(l)
      && !/^(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*$/i.test(l) && !/^\d{1,2}$/.test(l) && !/^[a-z]{3}$/i.test(l) && !/\bto\b.*\d/i.test(l)) || "";
    const path = m[1].replace(/^https?:\/\/(?:www\.)?downtownlongmont\.com/i, "");
    cards.push({ category, title, timeLine: timeLine || "", allDay, venue, date, url: `${DL_SITE}${path}` });
  }
  return cards;
}

// "Tween Night! Good Vibes-Cool Crafts-100% Fun! by Firehouse Art Center
// Firehouse Art Center Tween Night! ..." -> "Tween Night! Good Vibes-Cool Crafts-100% Fun!"
export function dlCleanTitle(title, venue) {
  let t = String(title || "").trim();
  if (venue) {
    const i = t.toLowerCase().indexOf(` by ${venue.toLowerCase()}`);
    if (i > 0) t = t.slice(0, i);
  }
  return t.replace(/\s*[-–|:@]\s*$/, "").trim();
}

// Worth fetching the event page for.
export function dlCandidate(card) {
  if (!card.timeLine || card.allDay) return false; // nothing to show as a time
  if (DL_COVERED_VENUE_RE.test(card.venue)) return false;
  const t = dlCleanTitle(card.title, card.venue);
  if (DL_ADULT_TITLE_RE.test(t)) return false;
  return DL_KID_RE.test(t) || DL_HINT_RE.test(t);
}

// The event page: title, Location text and Details text.
export function parseDlDetail(html) {
  const clean = String(html || "").replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ");
  const h1 = (clean.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i) || [])[1];
  const title = h1 ? decodeEntities(h1.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim() : "";
  // Section text between two headings, kept as HTML so the description
  // cleaner sees paragraph breaks.
  const section = (name) => {
    const re = new RegExp(`<h[2-4][^>]*>(?:\\s|<[^>]+>)*${name}(?:\\s|<[^>]+>)*<\\/h[2-4]>([\\s\\S]*?)(?=<h[1-4]\\b|<footer\\b|$)`, "i");
    return (clean.match(re) || [])[1] || "";
  };
  const details = section("Details");
  const location = decodeEntities(section("Location").replace(/<a\b[^>]*>\s*Visit Website\s*<\/a>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  return { title, details, location };
}

// Sentences that only point somewhere else ("Learn more at https://… or by
// calling 303-…") are useless without the link and leak contact details.
function dropContactSentences(s) {
  return s.split(/(?<=[.!?])\s+/)
    .filter((x) => !/https?:\/\/|www\.|\b\S+@\S+\.\w+|\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/.test(x))
    .join(" ").trim();
}

function dlAges(text, title) {
  let m = text.match(/\bages?\s*(\d{1,2})\s*(?:[-–]|to)\s*(\d{1,2})\b/i) || text.match(/\b(\d{1,2})\s*[-–]\s*(\d{1,2})\s*(?:years?|yrs?)\b/i);
  if (m) return { age_min: Number(m[1]), age_max: Number(m[2]) };
  if ((m = text.match(/\bages?\s*(\d{1,2})\s*(?:\+|and (?:up|older))/i))) return { age_min: Number(m[1]), age_max: 99 };
  if (/\btweens?\b/i.test(title)) return { age_min: 9, age_max: 12 };
  if (/\b(?:kids?|child(?:ren)?|santa|toddlers?|bab(?:y|ies)|preschool\w*|storytime)\b/i.test(title)) return { age_min: 0, age_max: 12 };
  return { age_min: 0, age_max: 99 };
}

const DL_MIN_NOTE = 40;

// One card + its event page -> a Playroute row, or null (with the reason
// in .reason for the run's drop counts).
export function mapDlEvent(card, detail) {
  const drop = (reason) => ({ drop: reason });
  if (!detail) return drop("page");
  const title = dlCleanTitle(card.title || detail.title, card.venue);
  const detailsText = decodeEntities(String(detail.details || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
  if (DL_ADULT_TEXT_RE.test(detailsText)) return drop("adult");
  if (!DL_KID_RE.test(title) && !DL_KID_RE.test(detailsText) && !DL_AGE_TEXT_RE.test(detailsText)) return drop("no-kid-signal");
  const ages = dlAges(detailsText, title);
  if (ages.age_min >= 13) return drop("teen");
  const tm = card.timeLine.match(TIME_LINE_RE);
  if (!tm) return drop("time");
  const start = clock(tm[1], tm[2], tm[3]);
  if (start.hhmm >= "20:00" && !DL_KID_RE.test(title)) return drop("late");
  const end = tm[4] ? clock(tm[4], tm[5], tm[6]) : null;
  let note = dropContactSentences(cleanEventDescription(detail.details, { title }));
  if (note && !/[.!?)"”]$/.test(note)) note += ".";
  if (note.length < DL_MIN_NOTE) return drop("thin-note");
  const venue = card.venue || "";
  return {
    title,
    source: venue ? `Downtown Longmont — ${venue}` : "Downtown Longmont",
    city: "Longmont",
    category: "community",
    cost: mentionsFee(detailsText) || /\btickets?\b/i.test(detailsText) ? "paid" : /\bfree\b/i.test(`${title} ${detailsText}`) ? "free" : "paid",
    ...ages,
    event_date: card.date,
    day_of_week: DAY_NAMES[new Date(`${card.date}T12:00:00Z`).getUTCDay()],
    start_time: start.hhmm,
    display_time: end && end.hhmm > start.hhmm ? `${start.label} – ${end.label}` : start.label,
    recurrence: "dated",
    note, // index.js truncates at a sentence boundary
    source_url: card.url
  };
}
