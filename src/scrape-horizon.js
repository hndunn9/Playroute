// Shared lookahead for scrapers: how far ahead a feed's events are kept.
// One month, so the review queue holds what families can plan for now,
// not next spring (Anythink Thornton queued events through March 2027
// before it had a cap). Use this for new scrapers instead of a per-source
// number unless a source has a reason to differ.
export const SCRAPE_HORIZON_DAYS = 30;

// YYYY-MM-DD in Mountain time (scrapers run in UTC; a 6pm MT run is
// already "tomorrow" in UTC).
export function mountainDateStr(date) {
  return date.toLocaleDateString("en-US", {
    timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit"
  }).replace(/(\d+)\/(\d+)\/(\d+)/, "$3-$1-$2");
}

// { today, horizon } as Mountain dates, horizon inclusive.
export function scrapeWindow(now = new Date(), days = SCRAPE_HORIZON_DAYS) {
  return { today: mountainDateStr(now), horizon: mountainDateStr(new Date(now.getTime() + days * 864e5)) };
}

// True when a YYYY-MM-DD date falls in [today, horizon]. Past events and
// anything beyond the horizon are dropped.
export function inScrapeWindow(dateStr, win) {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr || "") && dateStr >= win.today && dateStr <= win.horizon;
}
