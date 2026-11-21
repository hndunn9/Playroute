// npm test   (node --test tests/*.test.js)
import test from "node:test";
import assert from "node:assert/strict";
import { looksCancelled, stripDateSuffix, sameSlotTitle, contentFilter, preloadIngestIndex, checkDuplicateRiskIndexed } from "../src/pipeline.js";

test("cancellation words anywhere in the title", () => {
  assert.ok(looksCancelled("CANCELED: Baby Storytime"));
  assert.ok(looksCancelled("Closed cancelled Storytime at Meadows"));
  assert.ok(looksCancelled("Toddler Time - Cancelled"));
  assert.ok(!looksCancelled("Craft Storytime"));
});

test("cancellation in the description or a status field", () => {
  assert.ok(looksCancelled("Craft Storytime", "Craft Storytime is concluding in its current time slot, and no additional sessions will be offered at this time."));
  assert.ok(looksCancelled("Lego Club", "This program has been cancelled."));
  assert.ok(looksCancelled("Lego Club", "", ["no", "3", "Canceled"]));
  assert.ok(!looksCancelled("Sledding Party", "May be cancelled for bad weather."));
  assert.ok(!looksCancelled("Lego Club", "", ["no", "3", "Cancellations need 24 hours notice"]));
});

test("contentFilter drops cancelled candidates", () => {
  assert.equal(contentFilter({ title: "Storytime (CANCELLED)", note: "" }), "cancelled");
  assert.equal(contentFilter({ title: "Craft Storytime", note: "No additional sessions will be offered." }), "cancelled");
});

test("date suffixes come off titles", () => {
  assert.equal(stripDateSuffix("Bilingual Storytime (11/23/2026)"), "Bilingual Storytime");
  assert.equal(stripDateSuffix("All Ages Stay & Play Monday (11/23/2026 10:30 am)"), "All Ages Stay & Play Monday");
  assert.equal(stripDateSuffix("Mis Pininos (My First Steps)"), "Mis Pininos (My First Steps)");
});

test("same-slot titles match loosely", () => {
  assert.ok(sameSlotTitle("Boulder Phil Storytime", "Boulder Phil Story Time- Special Nutcracker Storytime with Boulder Ballet"));
  assert.ok(sameSlotTitle("Bilingual Storytime (11/23/2026)", "Bilingual Storytime"));
  assert.ok(!sameSlotTitle("Baby Storytime", "Toddler Storytime"));
});

function fakeEnv(rows) {
  return { DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }) } };
}

test("a reworded or date-suffixed title at the same place and time is a duplicate", async () => {
  const live = [
    { title: "Boulder Phil Story Time- Special Nutcracker Storytime with Boulder Ballet", city: "Boulder", event_date: "2026-11-25", start_time: "10:15", recurrence: "dated", source: "Boulder Public Library — Canyon Theater, Main Library, Theater", source_id: 1 },
    { title: "Bilingual Storytime", city: "Longmont", event_date: "2026-11-23", start_time: "10:00", recurrence: "dated", source: "Longmont Public Library 355 Emery St., Longmont, CO, United States", source_id: 3 },
    { title: "Storytime", city: "Boulder", event_date: "2026-11-30", start_time: "10:15", recurrence: "dated", source: "Boulder Public Library — Meadows Meeting Room, Meadows Library", source_id: 1 }
  ];
  const { live: idx } = await preloadIngestIndex(fakeEnv(live), null, [{ city: "Boulder" }]);
  const dup = (ev) => checkDuplicateRiskIndexed(idx, { recurrence: "dated", ...ev }).isDuplicate;
  assert.ok(dup({ title: "Boulder Phil Storytime", city: "Boulder", event_date: "2026-11-25", start_time: "10:15", source: "Boulder Public Library — Canyon Theater, Main Library, Theater" }));
  assert.ok(dup({ title: "Bilingual Storytime (11/23/2026)", city: "Longmont", event_date: "2026-11-23", start_time: "10:00", source: "Longmont Public Library 355 Emery St., Longmont, CO, United States" }));
  // Same program at another branch, same hour: a different event.
  assert.ok(!dup({ title: "Storytime at NoBo", city: "Boulder", event_date: "2026-11-30", start_time: "10:15", source: "Boulder Public Library — Community Room (2nd Floor), NoBo Library" }));
});
