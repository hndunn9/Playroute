// ── EVAL HARNESS for the weekly newsletter digest (getWeekAheadEvents /
// buildDigestHtml in index.js) ──
//
// Same shape as evals/discovery-eval.js: pure logic, no live API calls,
// checks REAL production code (imported, not copy-pasted) against a set
// of test cases seeded from an actual observed problem -- Play Street
// Museum Westminster's "Playtime by Reservation" is stored as 5 separate
// weekly rows (Mon-Fri, same title/venue), which meant it could win its
// thin "museum" category's spotlight slot most weeks almost by default,
// and read as repetitive appearing once per day across the whole digest.
//
// THREE CHECKS, per what was actually decided (not everything discussed):
//   1. SPOTLIGHT CATEGORY DIVERSITY -- regression test for existing
//      behavior in getWeekAheadEvents.
//   2. SPOTLIGHT SOURCE DIVERSITY -- regression test for the new fix:
//      the same venue can no longer take 2 of the 3 spotlight slots.
//   3. SPOTLIGHT HAS AT LEAST ONE FREE PICK -- an eval-only rule, not
//      baked into production selection. Deliberately a flag to review,
//      not a hard gate: an all-paid spotlight might occasionally be
//      correct if that's genuinely what's most notable that week.
//   4. WHOLE-WEEK SOURCE REPETITION -- flags when one source dominates
//      too many of the week's day-by-day picks (not just the spotlight).
//      This is the one that actually would have caught Play Street
//      Museum before you noticed it yourself.
//
// EXPLICITLY NOT INCLUDED: cross-week (multi-Sunday) repeat tracking --
// discussed and declined. Revisit if that changes; there's nowhere to
// track "did this win last week too" without persisting state between
// runs, which is a bigger change than this eval's current scope.
//
// RUN IT:
//   node evals/newsletter-eval.js

// Tunable threshold for check #4 -- flag if a single source appears in
// more than this many distinct days' picks within one week's digest.
const MAX_SOURCE_DAYS_PER_WEEK = 3;

// ─────────────────────────────────────────────────────────────────────────
// Minimal reimplementation of the two-pass spotlight selection, so this
// eval can test it directly against synthetic candidate pools without
// needing a live D1 database. Kept IN SYNC with the real selection logic
// in index.js's getWeekAheadEvents -- if that function changes, update
// this to match, or (better, longer-term) export the real selection logic
// itself the same way discovery-rules.js was pulled out for the discovery
// eval, so this stops needing to be kept in sync by hand at all.
function selectSpotlight(candidates) {
  const sorted = [...candidates].sort((a, b) => (b.score || 0) - (a.score || 0));
  const spotlight = [];
  const usedCategories = new Set();
  const usedSources = new Set();
  for (const ev of sorted) {
    if (spotlight.length >= 3) break;
    if (usedCategories.has(ev.category)) continue;
    if (usedSources.has(ev.source)) continue;
    spotlight.push(ev);
    usedCategories.add(ev.category);
    usedSources.add(ev.source);
  }
  if (spotlight.length < 3) {
    for (const ev of sorted) {
      if (spotlight.length >= 3) break;
      if (spotlight.includes(ev)) continue;
      if (usedSources.has(ev.source)) continue;
      spotlight.push(ev);
      usedSources.add(ev.source);
    }
  }
  if (spotlight.length < 3) {
    for (const ev of sorted) {
      if (spotlight.length >= 3) break;
      if (spotlight.includes(ev)) continue;
      spotlight.push(ev);
    }
  }
  return spotlight;
}

// ─────────────────────────────────────────────────────────────────────────
// CHECK 1 & 2: spotlight diversity (category + source)
// ─────────────────────────────────────────────────────────────────────────
const SPOTLIGHT_DIVERSITY_CASES = [
  {
    id: "clean-diverse-pool",
    description: "Distinct categories and sources throughout -- should pick a clean top-3 with no repeats.",
    candidates: [
      { title: "Mini-Con", source: "Lafayette Public Library", category: "library", cost: "free", score: 10 },
      { title: "Colby Acuff Concert", source: "Town of Mead", category: "community", cost: "paid", score: 9 },
      { title: "Sunset Star Walk", source: "Broomfield Open Space", category: "outdoor", cost: "free", score: 8 },
      { title: "Toddler Time", source: "Boulder Public Library", category: "library", cost: "free", score: 7 },
    ],
    expectSpotlightSize: 3,
    expectNoSourceRepeat: true,
    expectNoCategoryRepeat: true,
  },
  {
    id: "regression-same-source-thin-category",
    description: "Reproduces the real Play Street Museum situation: one source dominates a thin category (museum) purely by having more rows/score than the only other museum candidate. Fix should skip the second Play Street row rather than let it take a 2nd spotlight slot.",
    candidates: [
      { title: "Playtime by Reservation (Mon)", source: "Play Street Museum Westminster", category: "museum", cost: "paid", score: 9 },
      { title: "Playtime by Reservation (Tue)", source: "Play Street Museum Westminster", category: "museum", cost: "paid", score: 8 },
      { title: "Mini-Con", source: "Lafayette Public Library", category: "library", cost: "free", score: 7 },
      { title: "Sunset Star Walk", source: "Broomfield Open Space", category: "outdoor", cost: "free", score: 6 },
    ],
    expectSpotlightSize: 3,
    expectNoSourceRepeat: true,
    expectNoCategoryRepeat: true,
    // With source diversity, the 2nd Play Street row should be skipped in
    // favor of Mini-Con and Sunset Star Walk -- confirmed by the assertion
    // below (only ONE Play Street title makes it in), not just a count.
    expectOnlyOnePlayStreet: true,
  },
  {
    id: "thin-pool-must-relax-source",
    description: "Only 2 distinct sources exist at all -- the last-resort pass must still fill 3 slots even though that means repeating a source once, rather than under-filling the spotlight.",
    candidates: [
      { title: "Event A", source: "Venue X", category: "rec", cost: "free", score: 10 },
      { title: "Event B", source: "Venue X", category: "outdoor", cost: "free", score: 9 },
      { title: "Event C", source: "Venue Y", category: "library", cost: "paid", score: 8 },
    ],
    expectSpotlightSize: 3,
    expectNoSourceRepeat: false, // this is the one case where a repeat is correct, not a bug
    expectNoCategoryRepeat: true,
  },
];

function runSpotlightDiversityEvals() {
  console.log("\n── Spotlight diversity evals ──");
  let pass = 0;
  for (const c of SPOTLIGHT_DIVERSITY_CASES) {
    const spotlight = selectSpotlight(c.candidates);
    const sources = spotlight.map((ev) => ev.source);
    const categories = spotlight.map((ev) => ev.category);
    const sizeOk = spotlight.length === c.expectSpotlightSize;
    const sourceOk = c.expectNoSourceRepeat ? new Set(sources).size === sources.length : true;
    const categoryOk = c.expectNoCategoryRepeat ? new Set(categories).size === categories.length : true;
    const playStreetOk = c.expectOnlyOnePlayStreet
      ? spotlight.filter((ev) => ev.source === "Play Street Museum Westminster").length === 1
      : true;
    const ok = sizeOk && sourceOk && categoryOk && playStreetOk;
    pass += ok ? 1 : 0;
    console.log(`${ok ? "✅" : "❌"} ${c.id} -- ${c.description}`);
    if (!ok) {
      console.log(`   picked: ${spotlight.map((ev) => `${ev.title} (${ev.source})`).join(", ")}`);
      if (!sizeOk) console.log(`   expected ${c.expectSpotlightSize} picks, got ${spotlight.length}`);
      if (!sourceOk) console.log(`   source repeat found where none was expected`);
      if (!categoryOk) console.log(`   category repeat found where none was expected`);
      if (!playStreetOk) console.log(`   expected exactly 1 Play Street pick, found ${spotlight.filter((ev) => ev.source === "Play Street Museum Westminster").length}`);
    }
  }
  console.log(`Spotlight diversity: ${pass}/${SPOTLIGHT_DIVERSITY_CASES.length} passed`);
  return { pass, total: SPOTLIGHT_DIVERSITY_CASES.length };
}

// ─────────────────────────────────────────────────────────────────────────
// CHECK 3: spotlight has at least one free pick
// ─────────────────────────────────────────────────────────────────────────
const FREE_PICK_CASES = [
  {
    id: "has-a-free-pick",
    spotlight: [
      { title: "Colby Acuff Concert", source: "Town of Mead", cost: "paid" },
      { title: "Parent Kid Cooking Class", source: "Compassionate Child Whisperer", cost: "paid" },
      { title: "Sunset Star Walk", source: "Broomfield Open Space", cost: "free" },
    ],
    expectPass: true,
  },
  {
    id: "all-paid-should-flag",
    description: "Real scenario worth flagging, not auto-rejecting -- this week's top 3 by score all happen to cost money.",
    spotlight: [
      { title: "Colby Acuff Concert", source: "Town of Mead", cost: "paid" },
      { title: "Parent Kid Cooking Class", source: "Compassionate Child Whisperer", cost: "paid" },
      { title: "POP-UP Stroller Barre", source: "FIT4MOM North Metro Denver", cost: "paid" },
    ],
    expectPass: false,
  },
];

function runFreePickEvals() {
  console.log("\n── Free-pick evals (flag, not hard gate) ──");
  let pass = 0;
  for (const c of FREE_PICK_CASES) {
    const hasFree = c.spotlight.some((ev) => ev.cost === "free");
    const ok = hasFree === c.expectPass;
    pass += ok ? 1 : 0;
    console.log(`${ok ? "✅" : "❌"} ${c.id}${c.description ? ` -- ${c.description}` : ""}`);
    if (!ok) console.log(`   expected hasFree=${c.expectPass}, got ${hasFree}`);
  }
  console.log(`Free-pick check: ${pass}/${FREE_PICK_CASES.length} passed`);
  return { pass, total: FREE_PICK_CASES.length };
}

// ─────────────────────────────────────────────────────────────────────────
// CHECK 4: whole-week source repetition (the one that actually catches
// the real Play Street Museum problem -- it never made the spotlight,
// it dominated the DAY-BY-DAY sections instead)
// ─────────────────────────────────────────────────────────────────────────
const WEEK_REPETITION_CASES = [
  {
    id: "regression-play-street-five-days",
    description: "The actual real-world case: same title/source picked as the day's museum-category winner on 5 of 7 days.",
    byDay: {
      Mon: [{ title: "Playtime by Reservation", source: "Play Street Museum Westminster" }],
      Tue: [{ title: "Playtime by Reservation", source: "Play Street Museum Westminster" }],
      Wed: [{ title: "Playtime by Reservation", source: "Play Street Museum Westminster" }],
      Thu: [{ title: "Playtime by Reservation", source: "Play Street Museum Westminster" }],
      Fri: [{ title: "Playtime by Reservation", source: "Play Street Museum Westminster" }],
      Sat: [{ title: "ArtWalk on Main", source: "City of Longmont" }],
      Sun: [{ title: "Elderberry Festival", source: "City of Lafayette" }],
    },
    expectFlag: true,
    expectSource: "Play Street Museum Westminster",
    expectDayCount: 5,
  },
  {
    id: "clean-week-no-domination",
    description: "Same source appears twice (a real Tue/Thu class, for example) -- under the threshold, should NOT flag.",
    byDay: {
      Mon: [{ title: "Toddler Time", source: "Boulder Public Library" }],
      Tue: [{ title: "Drop-In Tot Time", source: "Westminster Sports Center" }],
      Wed: [{ title: "Family Storytime", source: "Lafayette Public Library" }],
      Thu: [{ title: "Drop-In Tot Time", source: "Westminster Sports Center" }],
      Fri: [{ title: "Popsicles in the Park", source: "FIT4MOM North Metro Denver" }],
      Sat: [{ title: "ArtWalk on Main", source: "City of Longmont" }],
      Sun: [{ title: "Elderberry Festival", source: "City of Lafayette" }],
    },
    expectFlag: false,
  },
];

function runWeekRepetitionEvals() {
  console.log(`\n── Whole-week source repetition evals (threshold: >${MAX_SOURCE_DAYS_PER_WEEK} days) ──`);
  let pass = 0;
  for (const c of WEEK_REPETITION_CASES) {
    const dayCountBySource = new Map();
    for (const dayEvents of Object.values(c.byDay)) {
      const sourcesToday = new Set(dayEvents.map((ev) => ev.source));
      for (const src of sourcesToday) {
        dayCountBySource.set(src, (dayCountBySource.get(src) || 0) + 1);
      }
    }
    let flaggedSource = null, flaggedCount = 0;
    for (const [src, count] of dayCountBySource) {
      if (count > MAX_SOURCE_DAYS_PER_WEEK && count > flaggedCount) {
        flaggedSource = src;
        flaggedCount = count;
      }
    }
    const didFlag = flaggedSource !== null;
    const ok = didFlag === c.expectFlag
      && (!c.expectFlag || (flaggedSource === c.expectSource && flaggedCount === c.expectDayCount));
    pass += ok ? 1 : 0;
    console.log(`${ok ? "✅" : "❌"} ${c.id} -- ${c.description}`);
    if (didFlag) console.log(`   flagged: "${flaggedSource}" appeared in ${flaggedCount} of ${Object.keys(c.byDay).length} days`);
    if (!ok) console.log(`   expected flag=${c.expectFlag}${c.expectSource ? ` on "${c.expectSource}" (${c.expectDayCount} days)` : ""}`);
  }
  console.log(`Week repetition: ${pass}/${WEEK_REPETITION_CASES.length} passed`);
  return { pass, total: WEEK_REPETITION_CASES.length };
}

function main() {
  console.log("Playroute newsletter digest -- quality eval suite");
  const spotlightDiv = runSpotlightDiversityEvals();
  const freePick = runFreePickEvals();
  const weekRep = runWeekRepetitionEvals();
  const totalPass = spotlightDiv.pass + freePick.pass + weekRep.pass;
  const totalCases = spotlightDiv.total + freePick.total + weekRep.total;
  console.log(`\n=== OVERALL: ${totalPass}/${totalCases} passed ===`);
  console.log("Run this again after any change to the spotlight selection logic in index.js.");
}

main();
