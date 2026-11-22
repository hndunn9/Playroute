// Pure text helpers shared by the scrapers that store a free-text `note`.
// Kept out of index.js so node tests can import them (index.js pulls in
// cloudflare:workers).

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…" };

export function decodeEntities(s) {
  return String(s || "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => (n.toLowerCase() in ENTITIES ? ENTITIES[n.toLowerCase()] : m));
}

// HTML -> plain text that keeps paragraph/line breaks as "\n", so the
// boilerplate filter below can drop whole logistics lines.
export function htmlToLines(html) {
  const text = decodeEntities(
    String(html || "")
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
      .replace(/<li[^>]*>/gi, "\n")
      .replace(/<\/?(?:a|em|strong|i|b|u|span|small|sup|sub|abbr)\b[^>]*>/gi, "")
      .replace(/<[^>]+>/g, " ")
  );
  return text.split(/\n+/).map((l) => l.replace(/[ \t ]+/g, " ").trim()).filter(Boolean);
}

const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
const WEEKDAY = "(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\\.?";
const CLOCK = "\\d{1,2}(?::\\d{2})?\\s*(?:a\\.?m\\.?|p\\.?m\\.?|noon)";
// A line that is only logistics the event row already carries in its own
// columns (date, time, place) or a call to action that means nothing once
// the link is gone.
const LABEL_LINE_RE = /^(?:date|dates|day|days|time|times|when|where|location|address|venue|schedule)s?\s*[:\-–—|]/i;
const CTA_LINE_RE = /^(?:register|sign up|signup|rsvp|tickets|buy tickets|get tickets|details|more info)[.!]?$|^(?:click here|register here|register now|register today|sign up here|sign up now|buy tickets|get tickets|learn more|more info(?:rmation)?|read more|view (?:event|details)|rsvp here|add to calendar)\b[^.]{0,40}$/i;
const DATE_ONLY_RE = new RegExp(`^(?:${WEEKDAY},?\\s*)?(?:${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s*\\d{4})?|\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?)(?:\\s*[,@|\\-\\u2013]\\s*${CLOCK}(?:\\s*[-\\u2013to]+\\s*${CLOCK})?)?\\.?$`, "i");
const TIME_ONLY_RE = new RegExp(`^${CLOCK}(?:\\s*(?:-|\\u2013|to)\\s*${CLOCK})?\\.?$`, "i");
// Inline "Date: Dec 7 | Time: 10am | Location: Main Hall" run at the start of
// a one-paragraph description.
const LEADING_LABELS_RE = /^(?:(?:date|time|when|where|location)s?\s*:\s*[^:]{1,80}?\s*(?:[|•;]\s*|\s(?=(?:date|time|when|where|location|cost|admission|ages?)s?\s*:)))+/i;

// Short lines that only restate when it happens: "First Mondays of the month
// at 10:00 AM - 11:00 AM", "October 5, November 2, December 7, January 4".
const CLOCK_RE = new RegExp(CLOCK, "i");
const MONTH_DAY_RE = new RegExp(`\\b${MONTH}\\s+\\d{1,2}\\b`, "gi");
function isScheduleLine(l) {
  if (l.length > 90 || l.split(/\s+/).length > 14) return false;
  if ((l.match(MONTH_DAY_RE) || []).length >= 2) return true;
  return CLOCK_RE.test(l) && /\b(?:every|each|first|second|third|fourth|last|mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?|daily|weekly|monthly|of the month|at)\b/i.test(l) && !/[.!?]\s+\S/.test(l);
}

export function cleanEventDescription(raw, { title = "" } = {}) {
  const t = String(title || "").trim().toLowerCase();
  const lines = htmlToLines(raw).map((l) => {
    // "Date: Dec 7 | Time: 10am | Kids make a craft" -> keep the prose tail.
    if (!LABEL_LINE_RE.test(l)) return l;
    const rest = l.replace(LEADING_LABELS_RE, "").trim();
    return rest !== l && rest.length >= 30 ? rest : "";
  }).filter((l) => {
    if (!l) return false;
    if (t && l.toLowerCase() === t) return false;
    if (CTA_LINE_RE.test(l)) return false;
    if (DATE_ONLY_RE.test(l) || TIME_ONLY_RE.test(l)) return false;
    if (isScheduleLine(l)) return false;
    return true;
  });
  // An "About <organiser>:" heading starts partner boilerplate; stop there.
  const about = lines.findIndex((l, i) => i > 0 && /^about\b[^.!?]{0,60}:?$/i.test(l));
  const kept = about > 0 ? lines.slice(0, about) : lines;
  let s = kept.map((l) => (/[.!?:;,)"\u201d]$/.test(l) ? l : `${l}.`)).join(" ").replace(/\s+/g, " ").trim();
  s = s.replace(LEADING_LABELS_RE, "").replace(/\s+([.,!?;:])/g, "$1").trim();
  // Trailing "Register here" / "Learn more" fragments glued onto a sentence.
  s = s.replace(/\s*(?:click here|register here|learn more|read more)\s*[.!]?$/i, "").trim();
  if (s && !/[.!?)"”]$/.test(s)) s += ".";
  return s;
}

// True when the text names a price other than $0 -- used to stop a $0
// tuition record (e.g. a class with a separate membership fee) being
// published as free.
export function mentionsFee(text) {
  const m = String(text || "").match(/\$\s?(\d+(?:\.\d{2})?)/g) || [];
  return m.some((x) => Number(x.replace(/[^\d.]/g, "")) > 0);
}

// Jackrabbit class names carry scheduling and admin tags the event row
// already has elsewhere: "Twinkle Stars (6mo-walking) Wed 9:30am ERIE".
const JR_CITIES = "erie|louisville|lafayette|boulder|broomfield|superior";
export function jrCleanTitle(name) {
  return String(name || "")
    .replace(/\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?\s+\d{1,2}(:\d{2})?\s*[ap]\.?m\.?/ig, "")
    .replace(new RegExp(`\\((?:${JR_CITIES})\\)`, "ig"), "")
    .replace(/\((?:[^()]*\d[^()]*(?:mo|mos|month|months|yr|yrs|year|years|walking|walkers?)[^()]*|ages?[^()]*)\)/ig, "")
    .replace(new RegExp(`(^|\\s)(?:${JR_CITIES.toUpperCase()}|HOLD|FULL|WAITLIST)(?=\\s|$)`, "g"), " ")
    .replace(/\s*[-–|:]\s*$/, "")
    .replace(/\s{2,}/g, " ").trim();
}
