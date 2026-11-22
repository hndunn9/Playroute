import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSessionSlots, expandToSessions, isWideWindow, wideListingCoversSession, labelToMinutes } from "../src/session-slots.js";

// Text as it reads on the live Longmont pages, 2026-11-22.
const ART_PAGE = "Discovery Days Art Thursday, Oct. 1 · 9:15 am - 2:15 pm Discovery Days Art with Ms. Leigh & Henry Wednesdays, Thursdays, Fridays, Saturdays; Classroom AB 9:15 am, 10:45 am, 1 pm; 1 hour 15 minutes per session Fall Themes Sept. 1, 2*, 3, 4, 5: Ocean Animals";
const MUSIC_PAGE = "Discovery Days Music & Movement Tuesday, Sep. 29 · 8 am - 5 pm Discovery Days Music & Movement with Ms. Ragen Tuesdays; Classroom C 9:15 am, 10:45 am, 1 pm; 45 minutes–1 hour per session Fall Themes";

const artListing = {
  title: "Discovery Days Art", source: "Longmont Museum", city: "Longmont", event_date: "2026-12-02",
  day_of_week: "Wednesday", start_time: "09:15", display_time: "9:15 am - 2:15 pm", recurrence: "dated",
  source_url: "https://longmontcolorado.gov/event/discovery-days-art-8/2026-12-02/"
};
const musicListing = { ...artListing, title: "Discovery Days Music & Movement", event_date: "2026-12-01", day_of_week: "Tuesday", start_time: "08:00", display_time: "8 am - 5 pm" };

test("labelToMinutes reads labels with and without minutes", () => {
  assert.equal(labelToMinutes("1 pm"), 780);
  assert.equal(labelToMinutes("9:15 am"), 555);
  assert.equal(labelToMinutes("12 pm"), 720);
  assert.equal(labelToMinutes("10:45 a.m."), 645);
});

test("parseSessionSlots reads the Art session list and its fixed length", () => {
  assert.deepEqual(parseSessionSlots(ART_PAGE), { starts: [555, 645, 780], durationMinutes: 75 });
});

test("parseSessionSlots reads the Music sessions; a length range gives no end time", () => {
  assert.deepEqual(parseSessionSlots(MUSIC_PAGE), { starts: [555, 645, 780], durationMinutes: null });
});

test("parseSessionSlots ignores a plain time range and returns null with no list", () => {
  assert.equal(parseSessionSlots("Saturday · 10 am - 11:30 am Story and craft"), null);
});

test("parseSessionSlots returns null when two different lists make it ambiguous", () => {
  assert.equal(parseSessionSlots("Art 9:15 am, 10:45 am. Music 9 am, 11 am, 2 pm."), null);
});

test("Art listing splits into its three sessions with end times", () => {
  const out = expandToSessions(artListing, parseSessionSlots(ART_PAGE));
  assert.deepEqual(out.map((c) => [c.start_time, c.display_time]), [
    ["09:15", "9:15 am - 10:30 am"], ["10:45", "10:45 am - 12 pm"], ["13:00", "1 pm - 2:15 pm"]
  ]);
  assert.ok(out.every((c) => c.event_date === "2026-12-02" && c.title === "Discovery Days Art"));
});

test("Music listing splits into sessions showing start time only", () => {
  const out = expandToSessions(musicListing, parseSessionSlots(MUSIC_PAGE));
  assert.deepEqual(out.map((c) => [c.start_time, c.display_time]), [["09:15", "9:15 am"], ["10:45", "10:45 am"], ["13:00", "1 pm"]]);
});

test("Sessions outside the listing's window leave the listing unchanged", () => {
  const slots = { starts: [555, 900], durationMinutes: 60 }; // 3 pm is after 2:15 pm
  assert.deepEqual(expandToSessions(artListing, slots), [artListing]);
  assert.deepEqual(expandToSessions(artListing, null), [artListing]);
});

test("isWideWindow is true for open-hours windows only", () => {
  assert.equal(isWideWindow(musicListing), true);
  assert.equal(isWideWindow(artListing), true);
  assert.equal(isWideWindow({ display_time: "10:30 am - 11:15 am" }), false);
});

test("wideListingCoversSession stops the false Discovery Days time-change flags", () => {
  // Live row 10:45 Art vs the feed's one 9:15-2:15 listing.
  assert.equal(wideListingCoversSession(artListing, { start_time: "10:45" }), true);
  // Several live sessions that day, one wide listing in the feed.
  assert.equal(wideListingCoversSession(musicListing, { start_time: "07:00" }, 3), true);
});

test("wideListingCoversSession still lets a real change through", () => {
  // Session-length listing moved: not a wide window.
  assert.equal(wideListingCoversSession({ display_time: "10 am - 11 am" }, { start_time: "09:15" }), false);
  // Wide window that no longer covers the only live session.
  assert.equal(wideListingCoversSession({ display_time: "1 pm - 5 pm" }, { start_time: "09:15" }, 1), false);
});
