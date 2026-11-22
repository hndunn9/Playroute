import { test } from "node:test";
import assert from "node:assert/strict";
import { isMeadEvent, mapMeadEvent } from "../src/hpld-sources.js";

// Shape seen on the live HPLD LibCal list 2026-11-22 (campus renamed from
// "Mead Public Library" to "Mead Library").
const ev = (over) => ({
  id: 17313880,
  title: "Mead Library Twinkle Babies",
  campus: "Mead Library",
  location: "Mead Meeting Room",
  startdt: "2026-11-30 09:30:00",
  enddt: "2026-11-30 10:00:00",
  all_day: false,
  audiences: [{ id: 1, name: "Baby/Toddler" }],
  url: "https://highplains.libcal.com/event/17313881",
  shortdesc: "Join us for Twinkle Babies Storytime! This storytime is designed specifically for babies from birth to about 18 months. You'll learn songs, stories, and the fundamental tools for aiding your baby's...",
  shortdesc_was_truncated: true,
  description: "<p>Join us for Twinkle Babies Storytime! This storytime is designed specifically for babies from birth to about 18 months. You&rsquo;ll learn songs, stories, and the fundamental tools for aiding your baby&rsquo;s development.</p><p>Register here</p>",
  ...over
});
const win = { today: "2026-11-22", horizon: "2027-01-06" };

test("isMeadEvent matches the renamed campus and the old name", () => {
  assert.equal(isMeadEvent(ev()), true);
  assert.equal(isMeadEvent(ev({ campus: "Mead Public Library" })), true);
  assert.equal(isMeadEvent(ev({ campus: "", location: "Mead Meeting Room" })), true);
  assert.equal(isMeadEvent(ev({ campus: "Erie Community Library", location: "Storytime Room" })), false);
  // An org/presenter named Mead elsewhere must not count.
  assert.equal(isMeadEvent(ev({ campus: "Carbon Valley Regional Library", location: "", org: "Stephanie Mead" })), false);
});

test("mapMeadEvent builds a dated kid row with times and ages", () => {
  const r = mapMeadEvent(ev(), win);
  assert.equal(r.title, "Mead Library Twinkle Babies");
  assert.equal(r.city, "Mead");
  assert.equal(r.event_date, "2026-11-30");
  assert.equal(r.day_of_week, "Monday");
  assert.equal(r.start_time, "09:30");
  assert.equal(r.display_time, "9:30am – 10:00am");
  assert.equal(r.age_min, 0);
  assert.equal(r.age_max, 3);
  assert.equal(r.source, "Mead Public Library — Mead Meeting Room");
  assert.equal(r.source_url, "https://highplains.libcal.com/event/17313881");
});

test("mapMeadEvent uses the full description, not LibCal's cut-off shortdesc", () => {
  const r = mapMeadEvent(ev(), win);
  assert.equal(r.note, "Join us for Twinkle Babies Storytime! This storytime is designed specifically for babies from birth to about 18 months. You’ll learn songs, stories, and the fundamental tools for aiding your baby’s development.");
  assert.ok(!r.note.endsWith("..."));
});

test("mapMeadEvent skips adult-only, all-day, cancelled and out-of-window events", () => {
  assert.equal(mapMeadEvent(ev({ audiences: [{ name: "Adult" }] }), win), null);
  assert.equal(mapMeadEvent(ev({ all_day: true }), win), null);
  assert.equal(mapMeadEvent(ev({ title: "CANCELLED: Twinkle Babies" }), win), null);
  assert.equal(mapMeadEvent(ev({ startdt: "2026-11-21 09:30:00" }), win), null);
  assert.equal(mapMeadEvent(ev({ startdt: "2027-02-01 09:30:00" }), win), null);
});

test("mapMeadEvent widens ages across several audiences", () => {
  const r = mapMeadEvent(ev({ audiences: [{ name: "Preschool" }, { name: "Elementary School" }] }), win);
  assert.deepEqual([r.age_min, r.age_max], [3, 11]);
});
