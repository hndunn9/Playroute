import { test } from "node:test";
import assert from "node:assert/strict";
import { SCRAPE_HORIZON_DAYS, mountainDateStr, scrapeWindow, inScrapeWindow } from "../src/scrape-horizon.js";

test("shared horizon is one month", () => {
  assert.equal(SCRAPE_HORIZON_DAYS, 30);
});

test("window runs from today to 30 days out, in Mountain time", () => {
  // 2026-11-22 18:00 UTC = 11am MT, the weekly-a run.
  const win = scrapeWindow(new Date("2026-11-22T18:00:00Z"));
  assert.deepEqual(win, { today: "2026-11-22", horizon: "2026-12-22" });
  // 03:00 UTC on the 23rd is still the 22nd in Denver.
  assert.equal(mountainDateStr(new Date("2026-11-23T03:00:00Z")), "2026-11-22");
});

test("keeps events inside the window, drops past and far-out ones", () => {
  const win = scrapeWindow(new Date("2026-11-22T18:00:00Z"));
  assert.equal(inScrapeWindow("2026-11-22", win), true);
  assert.equal(inScrapeWindow("2026-12-22", win), true);
  assert.equal(inScrapeWindow("2026-12-23", win), false);
  assert.equal(inScrapeWindow("2027-03-25", win), false); // the kind of row that flooded the queue
  assert.equal(inScrapeWindow("2026-11-18", win), false);
  assert.equal(inScrapeWindow("", win), false);
  assert.equal(inScrapeWindow(null, win), false);
});

test("window crosses the year cleanly", () => {
  const win = scrapeWindow(new Date("2026-12-20T18:00:00Z"));
  assert.equal(win.horizon, "2027-01-19");
  assert.equal(inScrapeWindow("2027-01-05", win), true);
  assert.equal(inScrapeWindow("2027-01-20", win), false);
});
