// Pure filters and row mapper for the High Plains Library District LibCal
// list (highplains.libcal.com/ajax/calendar/list). Network code stays in
// index.js; these take one event object so node tests can run on fixtures.
import { cleanEventDescription, decodeEntities } from "./event-text.js";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const HPLD_AUDIENCE_AGES = {
  "baby/toddler": [0, 3], "preschool": [3, 5], "elementary school": [5, 11],
  "family": [0, 12], "all ages": [0, 12]
};

export function hpldAges(audiences) {
  let min = null, max = null;
  for (const a of audiences || []) {
    const r = HPLD_AUDIENCE_AGES[String(a.name || "").toLowerCase()];
    if (!r) continue;
    if (min === null || r[0] < min) min = r[0];
    if (max === null || r[1] > max) max = r[1];
  }
  return min === null ? null : { age_min: min, age_max: max };
}

export function libcalClock(dt) {
  const m = /\s(\d{2}):(\d{2})/.exec(dt || "");
  if (!m) return null;
  let h = +m[1];
  const ap = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return { hhmm: `${m[1]}:${m[2]}`, label: `${h}:${m[2]}${ap}` };
}

// Same boundary-aware cut as index.js truncateAtBoundary.
function truncate(text, maxLen = 300) {
  const s = (text || "").trim();
  if (s.length <= maxLen) return s;
  const cut = s.slice(0, maxLen);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (end > maxLen * 0.6) return cut.slice(0, end + 1).trim();
  const sp = cut.lastIndexOf(" ");
  return (sp > maxLen * 0.6 ? cut.slice(0, sp) : cut).trim() + "…";
}

// 2026-11: HPLD renamed the campus "Mead Public Library" -> "Mead Library",
// which silently dropped every event. Match the word Mead in campus (or in
// the room name when campus is blank) rather than one exact string.
export function isMeadEvent(ev) {
  const campus = String(ev.campus || "").trim();
  if (campus) return /\bmead\b/i.test(campus);
  return /^mead\b/i.test(String(ev.location || "").trim());
}

// One LibCal event -> Playroute candidate, or null when it isn't a dated
// kid event inside [today, horizon].
export function mapMeadEvent(ev, { today, horizon }) {
  const date = String(ev.startdt || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < today || date > horizon) return null;
  if (ev.all_day || /cancel/i.test(ev.title || "")) return null;
  const ages = hpldAges(ev.audiences);
  if (!ages) return null; // adults / teens only
  const start = libcalClock(ev.startdt), end = libcalClock(ev.enddt);
  if (!start) return null;
  const title = decodeEntities(ev.title).replace(/\s+/g, " ").trim();
  // shortdesc is cut by LibCal ("...") whenever shortdesc_was_truncated;
  // the full description cleaned of logistics/CTA lines reads better.
  const desc = cleanEventDescription(ev.description || ev.shortdesc || "", { title });
  const room = decodeEntities(ev.location || "").trim();
  return {
    title,
    source: `Mead Public Library${room ? " — " + room : ""}`,
    city: "Mead",
    category: "library",
    cost: "free",
    age_min: ages.age_min,
    age_max: ages.age_max,
    day_of_week: DAY_NAMES[new Date(`${date}T12:00:00Z`).getUTCDay()],
    start_time: start.hhmm,
    display_time: end ? `${start.label} – ${end.label}` : start.label,
    recurrence: "dated",
    event_date: date,
    note: desc ? truncate(desc, 300) : null,
    source_url: ev.url || "https://highplains.libcal.com/calendar?cid=8181"
  };
}
