import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDlCards, dlCandidate, dlCleanTitle, parseDlDetail, mapDlEvent } from "../src/downtown-longmont.js";

// Card markup follows the live calendar's structure (2026-11-23): category,
// title, icon + time, icon + venue, optional tag, then the date badge.
const card = ({ slug, cat = "Creative District", title, time, venue, tag = true, badge = ["Fri", "4", "Dec"], range }) => `
<a href="/do/${slug}" class="event-card">
  <div class="info"><span class="cat">${cat}</span><h3>${title}</h3>
    ${time ? `<div class="time"><i class="icon"></i> ${time}</div>` : ""}
    ${venue ? `<div class="venue"><i class="icon"></i> ${venue}</div>` : ""}
    ${tag ? `<span class="tag">Creative District Event</span>` : ""}</div>
  <div class="date">${range ? `<span>${range}</span>` : badge.map((b) => `<span>${b}</span>`).join("")}</div>
</a>`;

const calendar = [
  card({ slug: "crochet-class-kids-learn-to-crochet", title: "Crochet Class: Kids Learn to Crochet", time: "10:30am - 1:30pm", venue: "Longmont Yarn Shoppe", badge: ["Wed", "25", "Nov"] }),
  card({ slug: "discovery-days-art-with-ms-leigh-and-henry-16", title: "Discovery Days: Art with Ms. Leigh and Henry", time: "9:15am - 2pm", venue: "Longmont Museum", badge: ["Fri", "27", "Nov"] }),
  card({ slug: "bogo-mimosas-and-screwdrivers-1", cat: "Events", title: "BOGO Mimosas &amp; Screwdrivers", time: "11am - 2pm", venue: "Drifters", tag: false, badge: ["Sun", "22", "Nov"] }),
  card({ slug: "main-street-bubbles", cat: "Events", title: "Main Street Bubbles!", venue: "Tangerine", tag: false, badge: ["Mon", "23", "Nov"] }),
  card({ slug: "small-business-saturday", cat: "Holidays", title: "Small Business Saturday", time: "All Day", tag: false, badge: ["Sat", "28", "Nov"] }),
  card({ slug: "sugar-plum-tea-party", title: "Sugar Plum Tea Party", time: "1pm - 3pm", venue: "The St Vrain", range: "Nov 28 — To — Nov 29" }),
  card({ slug: "tween-night-good-vibes-cool-crafts-100-fun-by-firehouse-art-center", title: "Tween Night! Good Vibes-Cool Crafts-100% Fun! by Firehouse Art Center Firehouse Art Center Tween Night! Good Vibes-Cool", time: "6pm - 8pm", venue: "Firehouse Art Center" }),
  card({ slug: "its-giving-friends-chosen-family-queer-dance-party-1", title: "It's Giving Friends- Chosen Family Queer Dance Party!", time: "9pm - 11:55pm", venue: "Drifters", badge: ["Wed", "25", "Nov"] }),
  card({ slug: "aladdin-jr-biggles-cast", title: "Aladdin Jr. (Biggles Cast)", time: "6pm", venue: "Dickens Opera House" }),
  card({ slug: "tween-night-jan", title: "Holiday Show", time: "2pm", venue: "Somewhere", badge: ["Fri", "1", "Jan"] })
].join("\n");

const detail = ({ h1, details, location = "<p><a href=\"/go/x\">Venue</a> 1 Main St</p>" }) => `<html><head><script>var x = "<h2>Details</h2>";</script></head><body>
<main><h1>${h1}</h1><p>Category: <a href="/events/calendar">Event Calendar</a></p>
<h2>Dates and Times</h2><ul><li><span>Friday, Dec 4, 2026 6pm - 8pm</span></li></ul>
<h2>Location</h2>${location}<p><a href="https://example.org/">Visit Website</a></p>
<h2>Details</h2>${details}
</main><section><h2>Discover More in Downtown Longmont</h2><a href="/post/perk-up">Perk Up</a></section><footer>515 Kimbark St.</footer></body></html>`;

test("parseDlCards reads title, time, venue and date from each card", () => {
  const cards = parseDlCards(calendar, "2026-11-23");
  assert.equal(cards.length, 10);
  const c = cards[0];
  assert.deepEqual(
    { title: c.title, timeLine: c.timeLine, venue: c.venue, date: c.date, url: c.url },
    { title: "Crochet Class: Kids Learn to Crochet", timeLine: "10:30am - 1:30pm", venue: "Longmont Yarn Shoppe", date: "2026-11-25", url: "https://www.downtownlongmont.com/do/crochet-class-kids-learn-to-crochet" }
  );
  assert.equal(cards[2].title, "BOGO Mimosas & Screwdrivers");
  assert.equal(cards[3].timeLine, "");
  assert.equal(cards[4].allDay, true);
  assert.equal(cards[5].date, "2026-11-28", "range card takes its first day");
  assert.equal(cards[5].venue, "The St Vrain");
  assert.equal(cards[9].date, "2027-01-01", "January cards seen in November are next year");
});

test("dlCandidate keeps family-looking cards and skips bars, covered venues and untimed cards", () => {
  const cards = parseDlCards(calendar, "2026-11-23");
  const picked = cards.filter(dlCandidate).map((c) => c.title.slice(0, 20));
  assert.deepEqual(picked, ["Crochet Class: Kids ", "Sugar Plum Tea Party", "Tween Night! Good Vi", "Aladdin Jr. (Biggles", "Holiday Show"]);
});

test("dlCleanTitle cuts the doubled 'by <venue>' tail", () => {
  assert.equal(dlCleanTitle("Tween Night! Good Vibes-Cool Crafts-100% Fun! by Firehouse Art Center Firehouse Art Center Tween Night! Good Vibes-Cool", "Firehouse Art Center"), "Tween Night! Good Vibes-Cool Crafts-100% Fun!");
  assert.equal(dlCleanTitle("Free Holiday Craft & Sip @ Bricks on Main", "Bricks on Main"), "Free Holiday Craft & Sip @ Bricks on Main");
});

test("parseDlDetail reads the Details section only, not scripts or the footer", () => {
  const d = parseDlDetail(detail({ h1: "Discovery Days: Art with Ms. Leigh and Henry", details: "<p>Hello families.</p>" }));
  assert.equal(d.title, "Discovery Days: Art with Ms. Leigh and Henry");
  assert.match(d.details, /Hello families/);
  assert.doesNotMatch(d.details, /Perk Up|Kimbark/);
  assert.equal(d.location, "Venue 1 Main St");
});

const cardsByTitle = (t) => parseDlCards(calendar, "2026-11-23").find((c) => c.title.startsWith(t));

test("mapDlEvent: kids' crochet class with an age range and a fee", () => {
  const d = parseDlDetail(detail({ h1: "Crochet Class: Kids Learn to Crochet", details: "<p>Join us for a kids' crochet class! This class is for 8-14 year old crochet students who want to learn the basics: chain stitch, single crochet and how to read a simple pattern.</p><p>Class fee is $40 and includes yarn and a hook.</p><p>Register</p>" }));
  const row = mapDlEvent(cardsByTitle("Crochet"), d);
  assert.equal(row.title, "Crochet Class: Kids Learn to Crochet");
  assert.equal(row.source, "Downtown Longmont — Longmont Yarn Shoppe");
  assert.deepEqual([row.age_min, row.age_max, row.cost], [8, 14, "paid"]);
  assert.deepEqual([row.event_date, row.day_of_week, row.start_time, row.display_time], ["2026-11-25", "Wednesday", "10:30", "10:30 AM – 1:30 PM"]);
  assert.equal(row.note, "Join us for a kids' crochet class! This class is for 8-14 year old crochet students who want to learn the basics: chain stitch, single crochet and how to read a simple pattern. Class fee is $40 and includes yarn and a hook.");
});

test("mapDlEvent drops pointer sentences with links or phone numbers", () => {
  const d = parseDlDetail(detail({ h1: "Aladdin Jr.", details: "<p>Join the young performers of the Biggles Cast for Disney's Aladdin Jr., a one-hour musical for the whole family.</p><p>Tickets and more at https://example.org/aladdin or by calling 303-555-0100.</p>" }));
  const row = mapDlEvent(cardsByTitle("Aladdin"), d);
  assert.equal(row.note, "Join the young performers of the Biggles Cast for Disney's Aladdin Jr., a one-hour musical for the whole family.");
  assert.equal(row.cost, "paid", "tickets mean it isn't free");
  assert.deepEqual([row.start_time, row.display_time], ["18:00", "6:00 PM"]);
});

test("mapDlEvent drops 21+ and teen-only events and events with no kid signal", () => {
  const adult = parseDlDetail(detail({ h1: "Sugar Plum Tea Party", details: "<p>Sip a festive cocktail with the cast. This evening is for guests 21+ only, so leave the little ones at home.</p>" }));
  assert.equal(mapDlEvent(cardsByTitle("Sugar Plum"), adult).drop, "adult");
  const teen = parseDlDetail(detail({ h1: "Holiday Show", details: "<p>A color-theory workshop with local painters, open to ages 16+ and to non-artists who want to learn.</p>" }));
  assert.equal(mapDlEvent(cardsByTitle("Holiday Show"), teen).drop, "adult");
  const none = parseDlDetail(detail({ h1: "Holiday Show", details: "<p>Shop local makers, sip something warm and find gifts for everyone on your list this season.</p>" }));
  assert.equal(mapDlEvent(cardsByTitle("Holiday Show"), none).drop, "no-kid-signal");
});

test("mapDlEvent keeps an all-ages ticketed tea with the real description", () => {
  const d = parseDlDetail(detail({ h1: "Sugar Plum Tea Party", details: "<p>Enjoy an afternoon tea with a mini Nutcracker performance and photos with your favorite characters &#8212; a sweet treat for all ages!</p><p>Tickets include tea, treats and the show.</p>" }));
  const row = mapDlEvent(cardsByTitle("Sugar Plum"), d);
  assert.equal(row.note, "Enjoy an afternoon tea with a mini Nutcracker performance and photos with your favorite characters — a sweet treat for all ages! Tickets include tea, treats and the show.");
  assert.deepEqual([row.age_min, row.age_max, row.cost, row.event_date], [0, 99, "paid", "2026-11-28"]);
});

test("mapDlEvent needs a real description", () => {
  const d = parseDlDetail(detail({ h1: "Aladdin Jr.", details: "<p>For kids!</p><p>Learn more</p>" }));
  assert.equal(mapDlEvent(cardsByTitle("Aladdin"), d).drop, "thin-note");
});
