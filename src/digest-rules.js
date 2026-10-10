// src/digest-rules.js
//
// Pure selection rules for the weekly newsletter's day-by-day section.
// No Workers imports, so src/newsletter-eval.js can run the real logic
// with plain `node` (same pattern as discovery-rules.js).
//
// Why this exists (2026-10): Longmont Museum's Discovery Days classes are
// stored as 3 rows per day (9:15, 10:45, 1:00), run Tue–Sat, and are all
// is_special -- so they outranked everything and filled 3 of 6 slots a day,
// five days running. Rules, in order:
//   1. Same title + same venue on the same day = ONE entry, times combined.
//   2. At most one entry per venue per day.
//   3. A series (same title + venue) shows once per week, on its first
//      day, with "also Thu, Fri" added to its time line.
//   4. A venue fills at most MAX_SOURCE_DAYS_PER_WEEK days of picks
//      (relaxed only to rescue a thin day with fewer than MIN_PER_DAY).

export const MAX_SOURCE_DAYS_PER_WEEK = 3;
export const MIN_PER_DAY = 3;

// Some older scraped `source` values have the street address baked in
// ("...— Steinbaugh Pavilion, 824 Front St"); newer ones don't. Strip any
// address-shaped fragment so the email reads consistently. Display only.
export function cleanSourceForDisplay(source) {
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

export function sourceKey(ev) {
  return cleanSourceForDisplay(ev.source).toLowerCase();
}

export function seriesKey(ev) {
  const title = (ev.title || "").toLowerCase().replace(/\s+/g, " ").trim();
  return `${sourceKey(ev)}|${title}`;
}

export function formatClock(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || "");
  if (!m) return hhmm || "";
  let h = Number(m[1]);
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m[2]} ${ap}`;
}

function joinList(items) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} & ${items[items.length - 1]}`;
}

const BADGE_RANK = { trending: 2, popular: 1 };

// Rule 1: collapse same-day sessions of the same thing into one entry.
export function mergeSameDaySessions(dayEvents) {
  const groups = new Map();
  for (const ev of dayEvents) {
    const k = seriesKey(ev);
    const list = groups.get(k) || [];
    list.push(ev);
    groups.set(k, list);
  }
  const merged = [];
  for (const list of groups.values()) {
    if (list.length === 1) { merged.push({ ...list[0] }); continue; }
    const sorted = list.slice().sort((a, b) => a.occurrence - b.occurrence);
    const first = sorted[0];
    const best = sorted.reduce((acc, e) => ((BADGE_RANK[e.badge] || 0) > (BADGE_RANK[acc] || 0) ? e.badge : acc), first.badge || null);
    merged.push({
      ...first,
      badge: best,
      is_new: sorted.some((e) => e.is_new),
      sessions: sorted.length,
      display_time: joinList(sorted.map((e) => formatClock(e.start_time))),
    });
  }
  return merged;
}

// Rules 2–4. `days` is an array of [label, events] in chronological order.
// Returns { byDay: Map(label -> { shown, total }), firstAppearances }.
export function selectDigestDays(days, interestScore, { maxPerDay = 6, tz = "America/Denver" } = {}) {
  const byDay = new Map();
  const seriesFirst = new Map(); // seriesKey -> the entry shown first
  const sourceDays = new Map();  // sourceKey -> days it appears in picks
  const firstAppearances = [];

  for (const [label, dayEvents] of days) {
    const merged = mergeSameDaySessions(dayEvents);

    // Rule 3: a series already shown earlier this week becomes an "also"
    // note on that first entry (unless a thin day needs it back, below).
    const eligible = [];
    const repeats = [];
    for (const ev of merged) {
      if (seriesFirst.has(seriesKey(ev))) repeats.push(ev);
      else eligible.push(ev);
    }

    const ranked = eligible.slice().sort((a, b) => {
      const diff = interestScore(b) - interestScore(a);
      return diff !== 0 ? diff : a.occurrence - b.occurrence;
    });

    const shown = [];
    const srcToday = new Set();
    const take = (ev) => { shown.push(ev); srcToday.add(sourceKey(ev)); };
    const allowed = (ev, weeklyCap) =>
      !shown.includes(ev) &&
      !srcToday.has(sourceKey(ev)) &&
      (!weeklyCap || (sourceDays.get(sourceKey(ev)) || 0) < MAX_SOURCE_DAYS_PER_WEEK);

    for (const ev of ranked) {
      if (shown.length >= maxPerDay) break;
      if (allowed(ev, true)) take(ev);
    }
    // Thin-day rescue: relax the weekly venue cap, then allow a repeat
    // series -- never the one-per-venue-per-day rule.
    for (const ev of ranked) {
      if (shown.length >= MIN_PER_DAY) break;
      if (allowed(ev, false)) take(ev);
    }
    const rankedRepeats = repeats.slice().sort((a, b) => interestScore(b) - interestScore(a) || a.occurrence - b.occurrence);
    for (const ev of rankedRepeats) {
      if (shown.length >= MIN_PER_DAY) break;
      if (allowed(ev, false)) take(ev);
    }
    for (const ev of repeats) {
      if (shown.includes(ev)) continue;
      const first = seriesFirst.get(seriesKey(ev));
      const d = ev.occurrence.toLocaleDateString("en-US", { weekday: "short", timeZone: tz });
      first.alsoDays = first.alsoDays || [];
      if (!first.alsoDays.includes(d)) first.alsoDays.push(d);
    }

    // Cost-tier balance: if a full day came out all free (or all paid) but
    // the other tier exists, swap the lowest pick for the best of the other.
    const tiers = new Set(shown.map((e) => e.cost));
    if (tiers.size === 1 && shown.length === maxPerDay) {
      const missing = shown[0].cost === "free" ? "paid" : "free";
      const dropped = shown[shown.length - 1];
      srcToday.delete(sourceKey(dropped));
      const alt = ranked.find((e) => e.cost === missing && allowed(e, true)) ||
                  ranked.find((e) => e.cost === missing && allowed(e, false));
      if (alt) { shown.pop(); take(alt); } else { srcToday.add(sourceKey(dropped)); }
    }

    for (const ev of shown) {
      if (seriesFirst.has(seriesKey(ev))) continue; // a rescued repeat
      seriesFirst.set(seriesKey(ev), ev);
      const sk = sourceKey(ev);
      sourceDays.set(sk, (sourceDays.get(sk) || 0) + 1);
      firstAppearances.push(ev);
    }
    shown.sort((a, b) => a.occurrence - b.occurrence);
    byDay.set(label, { shown, total: eligible.length });
  }

  for (const ev of firstAppearances) {
    if (ev.alsoDays && ev.alsoDays.length) ev.display_time = `${ev.display_time} · also ${ev.alsoDays.join(", ")}`;
  }
  return { byDay, firstAppearances };
}
