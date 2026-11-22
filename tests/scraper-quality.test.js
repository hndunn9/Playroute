import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanEventDescription, mentionsFee, jrCleanTitle } from "../src/event-text.js";
import { museumKeep, museumNote, bcParksKeep, mapBcParksEvent, tribeTiming } from "../src/tribe-sources.js";

// Fixtures are hand-built from the shapes seen on the live feeds 2026-11-22.
const bcCats = (...slugs) => [{ name: "Parks &amp; Open Space", slug: "parks-open-space" }, ...slugs.map((s) => ({ name: s, slug: s }))];
const bcEvent = (over) => ({
  title: "Hammering on the Farm",
  start_date: "2026-12-05 10:00:00",
  end_date: "2026-12-05 12:00:00",
  all_day: false,
  cost: "",
  url: "https://bouldercounty.gov/events/hammering-on-the-farm/",
  categories: bcCats("ag-heritage-center", "hikes-and-events"),
  venue: { venue: "Agricultural Heritage Center", city: "Longmont" },
  description: "<p>Drop by anytime to watch the blacksmith work his craft &#8212; listen to the clang of the hammer and the hum of the coal forge blower. Learn about blacksmithing tools such as hammers, tongs and anvils.</p><p>No registration required, but you can sign up to be notified if the event is canceled.</p>",
  ...over
});

test("cleanEventDescription drops date/time/location lines and calls to action", () => {
  const html = "<p>Saturday, December 7, 2026</p><p>10:00 am &#8211; 11:00 am</p><p>Location: Wonder Garden</p><p>Bilingual songs, movement and stories for families with young children.</p><p>Register here</p>";
  assert.equal(cleanEventDescription(html), "Bilingual songs, movement and stories for families with young children.");
});

test("cleanEventDescription strips an inline Date/Time run and the repeated title", () => {
  assert.equal(
    cleanEventDescription("<p>Storytime</p><p>Date: Dec 7 | Time: 10am | Kids hear a story and make a craft</p>", { title: "Storytime" }),
    "Kids hear a story and make a craft."
  );
});

test("cleanEventDescription keeps ordinary prose untouched", () => {
  const s = "Join us for a flat, easy 1-mile walk after dark. Bring a flashlight!";
  assert.equal(cleanEventDescription(`<p>${s}</p>`), s);
});

test("mentionsFee catches a fee on a $0 class, ignores $0", () => {
  assert.equal(mentionsFee("Free class. A $50 membership fee per semester applies."), true);
  assert.equal(mentionsFee("Cost: $0"), false);
  assert.equal(mentionsFee("Free drop-in play."), false);
});

test("jrCleanTitle drops ages, city tags and admin words", () => {
  assert.equal(jrCleanTitle("Twinkle Stars (6mo-walking) Wed 9:30am ERIE"), "Twinkle Stars");
  assert.equal(jrCleanTitle("Open Gym (Louisville) HOLD"), "Open Gym");
  assert.equal(jrCleanTitle("Twinkle Stars (ages 1-3)"), "Twinkle Stars");
});

test("museumKeep: kids yes, member-only no, member-tagged drop-in yes", () => {
  const kids = [{ name: "For Kids and Families" }];
  const member = [...kids, { name: "Member Exclusive" }];
  assert.equal(museumKeep({ categories: kids, description: "x" }), true);
  assert.equal(museumKeep({ categories: [{ name: "Lectures" }], description: "x" }), false);
  assert.equal(museumKeep({ categories: member, description: "Members-only preview night." }), false);
  assert.equal(museumKeep({ categories: member, description: "Drop-in, free with admission." }), true);
});

test("museumNote prefers the cleaned full description", () => {
  const e = {
    title: "Manitas Creativas",
    excerpt: "Saturday, December 7 10:00 am",
    description: "<p>Saturday, December 7</p><p>10:00 am - 11:00 am</p><p>Bilingual English/Spanish songs, movement, play and stories for families with young children.</p>"
  };
  assert.equal(museumNote(e), "Bilingual English/Spanish songs, movement, play and stories for families with young children.");
});

test("tribeTiming skips all-day and formats times", () => {
  assert.equal(tribeTiming({ all_day: true, start_date: "2026-12-05 00:00:00" }), null);
  assert.deepEqual(tribeTiming(bcEvent({})), { event_date: "2026-12-05", day_of_week: "Saturday", start_time: "10:00", display_time: "10:00 AM – 12:00 PM" });
});

test("Boulder County parks: family programs kept with venue and clean note", () => {
  const row = mapBcParksEvent(bcEvent({}));
  assert.equal(row.source, "Boulder County Parks & Open Space — Agricultural Heritage Center");
  assert.equal(row.city, "Longmont");
  assert.equal(row.category, "museum");
  assert.equal(row.cost, "free");
  assert.match(row.note, /^Drop by anytime to watch the blacksmith/);
  assert.doesNotMatch(row.note, /<|&#/);
});

test("Boulder County parks: registration-required walk gets the flag", () => {
  const row = mapBcParksEvent(bcEvent({
    title: "Winter Solstice Night Walk at Pella Crossing",
    categories: bcCats("hikes-and-events"),
    venue: { venue: "Pella Crossing", city: "Longmont" },
    description: "<p>On the longest night of the year, join volunteer naturalists for a flat, easy 1-mile walk around the ponds after dark.</p><p>Registration required.</p>"
  }));
  assert.equal(row.category, "outdoor");
  assert.match(row.note, /Registration required\.$/);
});

test("Boulder County parks: meetings, seniors-only, work days and hours-only listings dropped", () => {
  const drop = [
    { title: "Prairie Dog Management Annual Stakeholder Meeting" },
    { title: "Parks & Open Space Advisory Committee (POSAC)" },
    { title: "Hikes for Seniors: Winter at the Preserve" },
    { title: "Volunteer Work Project: Weed Pull" },
    { title: "Agricultural Heritage Center Open", description: "<p>Open 10 a.m. to 5 p.m. the first Saturday.</p>" },
    { categories: [{ name: "Parks & Open Space", slug: "parks-open-space" }] },
    { all_day: true }
  ];
  for (const over of drop) assert.equal(mapBcParksEvent(bcEvent(over)), null, JSON.stringify(over));
});

test("Boulder County parks: 'volunteer naturalists' alone does not drop a program", () => {
  assert.equal(bcParksKeep(bcEvent({ title: "Birds of Prey Slideshow Program", description: "<p>Volunteer naturalists share tips for identifying hawks and eagles.</p>" })), true);
});

// Verbatim descriptions from bouldercounty.gov's API, 2026-11-22.
const LIVE_BC = [
  { title: "Birds of Prey Driving Tour", start_date: "2026-12-05 09:00:00", end_date: "2026-12-05 12:00:00", all_day: false, cost: "", url: "https://bouldercounty.gov/event/birds-of-prey-driving-tour-dec-5/", venue: [],
    categories: [{ name: "Hikes &amp; Events", slug: "hikes-and-events" }, { name: "Parks &amp; Open Space", slug: "parks-open-space" }],
    description: "<p>Hop in your car with friends and family and join us for a driving tour of some of Boulder County’s best areas to view birds of prey. Follow the tour map to designated stops with volunteer naturalists, search the skies for raptors, learn about their habitats and behaviors, and work on your observation and identification skills.</p>\n<p><strong>Registration required.</strong></p>\n<p><a class=\"button\" href=\"https://discover.bouldercounty.gov/ActivityRegistration/x\">Register</a></p>\n<style>.tribe-events-c-subscribe-dropdown{display:none;}</style>" },
  { title: "Agricultural Heritage Center Open", start_date: "2026-12-05 10:00:00", end_date: "2026-12-05 17:00:00", all_day: false, cost: "", url: "https://bouldercounty.gov/event/ahc-open-dec-5/", venue: { venue: "Agricultural Heritage Center", city: "Longmont" },
    categories: [{ name: "Ag Heritage Center", slug: "ag-heritage-center" }, { name: "Parks &amp; Open Space", slug: "parks-open-space" }],
    description: "<p>The <a href=\"x\">Agricultural Heritage Center</a> is open 10 a.m. – 5 p.m.</p>\n<p><strong>Nov. 1 to March 31</strong><br />\nThe first Saturday of the month<br />\n10 a.m. – 5 p.m.</p>" },
  { title: "Hammering on the Farm", start_date: "2026-12-05 10:00:00", end_date: "2026-12-05 12:00:00", all_day: false, cost: "", url: "https://bouldercounty.gov/event/hammering-on-the-farm-dec-5/", venue: { venue: "Agricultural Heritage Center", city: "Longmont" },
    categories: [{ name: "Ag Heritage Center", slug: "ag-heritage-center" }, { name: "Hikes &amp; Events", slug: "hikes-and-events" }, { name: "Parks &amp; Open Space", slug: "parks-open-space" }],
    description: "<p>Drop by anytime from 10 a.m. to noon to watch the blacksmith work his craft. Listen to the clang-clang-clang of the hammer and the hum of the coal forge blower. Learn about blacksmithing tools such as hammers, tongs, anvils, swage blocks, and more. Registration is not required for this activity, but you can still sign up to be notified in case the event is unexpectedly canceled.</p>\n<p><a class=\"button\" href=\"x\">Sign Up</a></p>\n<style>.tribe-events-c-subscribe-dropdown{display:none;}</style>" }
];

test("Boulder County parks on live samples: clean notes, hours listing dropped", () => {
  const [tour, open, hammer] = LIVE_BC.map(mapBcParksEvent);
  assert.equal(open, null);
  assert.equal(tour.source, "Boulder County Parks & Open Space");
  assert.equal(tour.note.endsWith("identification skills. Registration required."), true, tour.note);
  assert.doesNotMatch(tour.note, /Register$|display:none|tribe-events/);
  assert.equal(hammer.note.endsWith("unexpectedly canceled."), true, hammer.note);
  assert.equal(hammer.display_time, "10:00 AM – 12:00 PM");
});

test("Boulder County parks: a Register button with no stated rule becomes 'Register ahead.'", () => {
  const row = mapBcParksEvent({
    title: "Winter Solstice Night Walk at Pella Crossing", start_date: "2026-12-19 16:30:00", end_date: "2026-12-19 18:30:00", all_day: false, cost: "",
    url: "https://bouldercounty.gov/event/winter-solstice-night-walk-at-pella-crossing/", venue: { venue: "Pella Crossing", city: "Longmont" },
    categories: [{ name: "Hikes &amp; Events", slug: "hikes-and-events" }, { name: "Parks &amp; Open Space", slug: "parks-open-space" }],
    description: "<p>On the longest night of the year, experience what the night has to offer. Join volunteer naturalists for a flat, easy, 1-mile walk around the ponds at Pella Crossing. Explore open space after hours and discover the secrets of the dark, including local nocturnal wildlife and the winter constellations in the night sky.</p>\n<p><a class=\"button\" href=\"x\">Register</a></p>\n<style>.tribe-events-c-subscribe-dropdown{display:none;}</style>"
  });
  assert.equal(row.source, "Boulder County Parks & Open Space — Pella Crossing");
  assert.equal(row.display_time, "4:30 PM – 6:30 PM");
  assert.match(row.note, /night sky\. Register ahead\.$/);
});

test("Museum of Boulder on a live sample: schedule lines and partner bio removed, drop-in kept", () => {
  const e = {
    title: "Manitas Creativas with Luna Cultura", excerpt: "",
    categories: [{ name: "All Events Calendar" }, { name: "For Kids and Families" }, { name: "Member Exclusive" }],
    description: "<p><em>First Mondays of the month at 10:00 AM &#8211; 11:00 AM</em></p>\n<p><em>October 5, November 2, December 7, January 4</em></p>\n<blockquote><p><strong>Drop-in, free with admission to the Museum of Boulder</strong></p></blockquote>\n<p><em>If the cost is prohibitive to you, please pay what you wish.</em></p>\n<p>Join us for an hour of bilingual joy with your little one! Sing, move, play, explore, and enjoy stories together with <a href=\"https://lunacultura.org/\">Luna Cultura</a>.<i> Manitas Creativas</i> welcomes families who are learning Spanish, families who speak Spanish at home, and families who speak English at home and want to explore bilingual environments.</p>\n<p><strong>About Luna Cultura:</strong></p>\n<p>We are a bilingual, bicultural, and woman-owned company committed to building strong, inclusive communities.</p>"
  };
  assert.equal(museumKeep(e), true);
  const note = museumNote(e);
  assert.match(note, /^Drop-in, free with admission to the Museum of Boulder\. If the cost is prohibitive/);
  assert.match(note, /together with Luna Cultura\. Manitas Creativas welcomes/);
  assert.doesNotMatch(note, /First Mondays|October 5|woman-owned/);
});
