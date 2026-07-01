/**
 * Boulder Public Library scraper.
 *
 * Boulder declined to issue a LibCal API token, so this scrapes the public
 * calendar directly instead. Two-stage approach, based on what we confirmed
 * by hand:
 *
 *   1. DISCOVERY (needs a real browser): the calendar's list/search view
 *      loads events via JavaScript after page load — a plain fetch only
 *      gets the empty page shell. Playwright renders the page and pulls
 *      out event detail-page URLs.
 *
 *   2. DETAIL (plain HTTP is enough): individual LibCal event pages
 *      (calendar.boulderlibrary.org/event/<id>) render as static
 *      server-side HTML with no JS required — confirmed by fetching one
 *      directly. So stage 2 doesn't need Playwright at all, just fetch.
 *
 * IMPORTANT — selectors below are best-effort, not verified against the
 * live rendered DOM (I can't run a browser from where this was written).
 * The discovery step is written to be resilient to markup changes by
 * matching on href pattern (`/event/<digits>`) rather than specific CSS
 * classes, since that's the one thing unlikely to change. The detail-page
 * parsing is more fragile — run this once, log a sample raw event object,
 * and adjust the regex/selectors in `parseEventDetail` against what you
 * actually see before trusting it for a real scheduled run.
 */

import { chromium } from "playwright";
import * as cheerio from "cheerio";

// The filtered "birth to age 5" view you found. Swap audience= value or
// drop it entirely to widen/narrow what gets pulled.
const CALENDAR_URL =
  "https://calendar.boulderlibrary.org/calendar/events/?cid=12892&t=d&d=0000-00-00&cal=12892&audience=6405&inc=0";

const BASE_URL = "https://calendar.boulderlibrary.org";

async function discoverEventUrls() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.goto(CALENDAR_URL, { waitUntil: "networkidle" });

  // Give the calendar widget's AJAX call a moment beyond networkidle —
  // some LibCal instances do a secondary render pass.
  await page.waitForTimeout(1500);

  const hrefs = await page.$$eval("a", (anchors) =>
    anchors.map((a) => a.getAttribute("href")).filter(Boolean)
  );

  await browser.close();

  const eventUrls = new Set();
  for (const href of hrefs) {
    const match = href.match(/\/event\/(\d+)/);
    if (match) {
      eventUrls.add(`${BASE_URL}/event/${match[1]}`);
    }
  }

  return [...eventUrls];
}

/**
 * Parses a single event detail page.
 *
 * The label-based regex below (Date:/Time:/Location:/Audience:/Categories:)
 * is no longer a guess — it's confirmed against a real export of Boulder's
 * filtered calendar (Jul 1-7, 2026), which showed exactly this field
 * structure for every event. Detail pages should match closely since
 * they're rendered by the same LibCal system, but this still hasn't been
 * run against a live detail page directly — worth a first supervised run
 * before trusting it unattended.
 */
function parseEventDetail(html, url) {
  const $ = cheerio.load(html);
  // Collapse all whitespace/newlines to single spaces, so the label-based
  // regex below can search across what would otherwise be line breaks.
  const text = $("body").text().replace(/\s+/g, " ").trim();

  const title = $("h1").first().text().trim() || null;

  // The description paragraph (between the title and "Date:") is where the
  // *specific* age range actually lives — e.g. "ages 3-5" or "birth-15
  // months". The structured Audience field below is only ever the broad
  // LibCal category ("Birth to age 5"), which covers babies through
  // kindergarten-age with no finer distinction — confirmed by comparing
  // multiple real events that had wildly different specific ages but the
  // identical broad Audience value.
  const descMatch = text.match(/^(.*?)\s*Date:/i);
  const description = descMatch ? descMatch[1].replace(title || "", "").trim() : "";

  const dateMatch = text.match(/Date:\s*(\w+day),?\s+([A-Za-z]+\.?\s+\d{1,2}\.?,?\s+\d{4})/i);
  const timeMatch = text.match(/Time:\s*(\d{1,2}:\d{2}\s*[ap]m)\s*-\s*(\d{1,2}:\d{2}\s*[ap]m)/i);

  const LABELS = "(?:Date|Time|Location|Audience|Categories|Registration Type|Register)";
  const locationMatch = text.match(new RegExp(`Location:\\s*(.*?)\\s*${LABELS}:`, "i"));
  const audienceMatch = text.match(new RegExp(`Audience:\\s*(.*?)\\s*${LABELS}:`, "i"));
  const categoriesMatch = text.match(new RegExp(`Categories:\\s*(.*?)(?:\\s*${LABELS}:|$)`, "i"));
  const cancelled = /^CANCELLED/i.test(title || "");

  return {
    title,
    description,
    cancelled,
    source_url: url,
    raw_day: dateMatch ? dateMatch[1] : null,
    raw_date: dateMatch ? dateMatch[2] : null,
    raw_start: timeMatch ? timeMatch[1] : null,
    raw_end: timeMatch ? timeMatch[2] : null,
    location: locationMatch ? locationMatch[1].trim() : null,
    audience: audienceMatch ? audienceMatch[1].trim() : null,
    categories: categoriesMatch ? categoriesMatch[1].trim() : null,
    // Keep the raw text around so you can eyeball what the regexes missed
    // on your first real run.
    _rawTextSample: text.slice(0, 500),
  };
}

async function fetchEventDetail(url) {
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`Failed to fetch ${url}: ${res.status}`);
    return null;
  }
  const html = await res.text();
  return parseEventDetail(html, url);
}

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

function to24Hour(time12h) {
  const m = time12h.trim().match(/(\d{1,2}):(\d{2})\s*([ap]m)/i);
  if (!m) return null;
  let [, h, min, ap] = m;
  h = parseInt(h, 10);
  if (ap.toLowerCase() === "pm" && h !== 12) h += 12;
  if (ap.toLowerCase() === "am" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${min}`;
}

function to12HourDisplay(time12h) {
  return time12h.trim().replace(/(am|pm)/i, (m) => ` ${m.toUpperCase()}`);
}

/**
 * Age inference — checks the specific description text FIRST (e.g. "ages
 * 3-5", "birth-15 months", "16-36 months"), since that's where the real
 * granularity lives. Only falls back to the broad Audience field (always
 * just "Birth to age 5" for this whole category) if nothing specific is
 * found in the description — matches how these were manually extracted
 * from the confirmed PDF export.
 */
function ageFromText(description, audience) {
  const d = (description || "").toLowerCase();

  let m = d.match(/birth\s*[-–]\s*(\d+)\s*months?/);
  if (m) return { age_min: 0, age_max: +m[1] / 12 };

  m = d.match(/(\d+)\s*[-–]\s*(\d+)\s*months?/);
  if (m) return { age_min: +m[1] / 12, age_max: +m[2] / 12 };

  m = d.match(/ages?\s*(\d+)\s*[-–]\s*(\d+)/);
  if (m) return { age_min: +m[1], age_max: +m[2] };

  m = d.match(/(\d+)\s*[-–]\s*(\d+)\s*years?/);
  if (m) return { age_min: +m[1], age_max: +m[2] };

  const a = (audience || "").toLowerCase();
  if (a.includes("birth to age 5") || a.includes("birth-5")) return { age_min: 0, age_max: 5 };
  m = a.match(/ages?\s*(\d+)\s*to\s*(\d+)/);
  if (m) return { age_min: +m[1], age_max: +m[2] };

  return { age_min: 0, age_max: 8 }; // fallback: don't over-narrow if we genuinely can't tell
}

function normalizeEvent(detail) {
  if (!detail.title || !detail.raw_day || !detail.raw_start) return null;

  const { age_min, age_max } = ageFromText(detail.description, detail.audience);
  const start24 = to24Hour(detail.raw_start);
  const displayTime = detail.raw_end
    ? `${to12HourDisplay(detail.raw_start)} – ${to12HourDisplay(detail.raw_end)}`
    : to12HourDisplay(detail.raw_start);

  return {
    title: detail.title,
    source: `Boulder Public Library${detail.location ? " — " + detail.location : ""}`,
    city: "Boulder",
    category: "library",
    cost: "free",
    age_min,
    age_max,
    day_of_week: detail.raw_day,
    start_time: start24,
    display_time: displayTime,
    recurrence: "weekly",
    note: detail.categories ? `Category: ${detail.categories}` : "Scraped from Boulder Public Library calendar.",
    source_url: detail.source_url,
  };
}

async function postToIngest(events) {
  const workerUrl = process.env.PLAYROUTE_WORKER_URL;
  const secret = process.env.PLAYROUTE_INGEST_SECRET;

  if (!workerUrl || !secret) {
    console.log("\nPLAYROUTE_WORKER_URL / PLAYROUTE_INGEST_SECRET not set — skipping ingest, printing JSON instead.\n");
    console.log(JSON.stringify(events, null, 2));
    return;
  }

  const res = await fetch(`${workerUrl}/api/ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({ events }),
  });

  const result = await res.json();
  console.log("Ingest result:", result);
}

async function main() {
  console.log("Discovering event URLs (headless browser)...");
  const urls = await discoverEventUrls();
  console.log(`Found ${urls.length} event URLs.`);

  const details = [];
  for (const url of urls) {
    console.log(`Fetching detail: ${url}`);
    const detail = await fetchEventDetail(url);
    if (detail) details.push(detail);
  }

  const normalized = details
    .filter((d) => !d.cancelled)
    .map(normalizeEvent)
    .filter(Boolean);

  console.log(`\nParsed ${details.length} pages, ${normalized.length} usable events (after skipping cancelled/unparseable).\n`);

  await postToIngest(normalized);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
