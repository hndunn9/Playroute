// ── EVAL HARNESS for the LLM discovery pipeline (discovery-workflow.js) ──
//
// WHAT THIS IS, IN ONE SENTENCE: a repeatable test suite that scores your
// LLM pipeline's output against known-good expectations, so you can tell
// whether a prompt/model change made things better or worse without
// eyeballing every candidate by hand.
//
// THREE KINDS OF EVALS, ALL DEMONSTRATED BELOW:
//   1. STRUCTURAL  -- does the output satisfy fixed rules? (valid enum
//      values, required fields present, no past dates). This is exactly
//      what passesQueueBar() already does in production -- we import the
//      REAL function here rather than re-implementing it, so this eval
//      always tests your actual production logic, never a copy that could
//      quietly drift out of sync with it.
//   2. REGRESSION   -- does the pipeline still correctly reject specific
//      failure patterns you've hit before in real runs? Each case below is
//      reconstructed from an actual bug-fix comment in discovery-workflow.js
//      (irregular recurrence classification, comma-separated multi-day
//      strings, weekly candidates skipping date validation). If any of
//      these ever starts passing again, that's a real regression.
//   3. LLM-AS-JUDGE -- for the free-text `note` field, there's no single
//      correct string to compare against, so a second model call scores it
//      against a rubric (accurate, not fabricated, not truncated, not a
//      placeholder). This needs ANTHROPIC_API_KEY -- see runLLMJudgeEvals()
//      below for how to set it; the suite skips this section gracefully
//      if it's not set, so you can run the free parts immediately.
//
// HOW TO GROW THIS OVER TIME: every time you catch a bad candidate in the
// pending-review queue, that's a free test case. Copy its exact shape into
// REGRESSION_CASES below with expectPass: false and a one-line note on what
// was wrong. That's the whole workflow -- evals are just accumulated
// receipts from real mistakes, run automatically instead of by memory.
//
// RUN IT:
//   node evals/discovery-eval.js
//   ANTHROPIC_API_KEY=sk-... node evals/discovery-eval.js   (to include the judge evals)

import { passesQueueBar, CATEGORIES, DISCOVERY_SYSTEM_PROMPT } from "../discovery-rules.js";

// ─────────────────────────────────────────────────────────────────────────
// 1. STRUCTURAL EVAL CASES
// A mix of candidates that SHOULD pass (clean, complete) and SHOULD fail
// (missing/invalid fields), so the suite can catch a checker that's become
// too strict OR too lenient -- not just "does it reject bad stuff."
// ─────────────────────────────────────────────────────────────────────────
const STRUCTURAL_CASES = [
  {
    id: "clean-weekly-candidate",
    expectPass: true,
    candidate: {
      title: "Toddler Music Circle", source: "Longmont Rec Center", city: "Longmont",
      category: "rec", cost: "free", age_min: 1, age_max: 3,
      day_of_week: "Wednesday", start_time: "10:00", display_time: "10:00 AM",
      recurrence: "weekly", event_date: "2026-09-09",
      note: "Sing-along circle time for toddlers and caregivers, no registration needed.",
      source_url: "https://longmontcolorado.gov/rec/toddler-music", confidence: "high"
    }
  },
  {
    id: "clean-dated-candidate",
    expectPass: true,
    candidate: {
      title: "Fall Pumpkin Patch Day", source: "Ollin Farms", city: "Longmont",
      category: "outdoor", cost: "paid", age_min: 0, age_max: 99,
      day_of_week: "Saturday", start_time: "10:00", display_time: "10:00 AM",
      recurrence: "dated", event_date: "2026-10-11",
      note: "Pick-your-own pumpkins, hayrides, and a corn maze for the whole family.",
      source_url: "https://ollinfarms.com/pumpkin-patch", confidence: "high"
    }
  },
  {
    id: "missing-core-field",
    expectPass: false,
    candidate: {
      title: "Mystery Class", source: "", city: "Boulder", // source blank
      category: "rec", cost: "free", age_min: 0, age_max: 5,
      day_of_week: "Monday", start_time: "09:00", display_time: "9:00 AM",
      recurrence: "weekly", event_date: "2026-09-08",
      note: "A class.", source_url: "https://example.com", confidence: "high"
    }
  },
  {
    id: "placeholder-display-time",
    expectPass: false,
    candidate: {
      title: "Craft Hour", source: "Some Library", city: "Erie",
      category: "library", cost: "free", age_min: 3, age_max: 8,
      day_of_week: "Friday", start_time: "10:00", display_time: "check listing for time",
      recurrence: "weekly", event_date: "2026-09-11",
      note: "Weekly craft session for kids.", source_url: "https://example.com", confidence: "high"
    }
  },
  {
    id: "low-confidence-should-be-dropped",
    expectPass: false,
    // Real fabrication risk noted in the code comments: the model wasn't
    // fully sure this exists. Confidence != "high" must hard-fail, not warn.
    candidate: {
      title: "Maybe-Weekly Puppet Show", source: "Unclear Venue", city: "Boulder",
      category: "community", cost: "free", age_min: 0, age_max: 6,
      day_of_week: "Sunday", start_time: "11:00", display_time: "11:00 AM",
      recurrence: "weekly", event_date: "2026-09-14",
      note: "A puppet show that might happen weekly, based on an old page.",
      source_url: "https://example.com", confidence: "low"
    }
  }
];

// ─────────────────────────────────────────────────────────────────────────
// 2. REGRESSION CASES -- reconstructed from real bug-fix comments in
// discovery-workflow.js. Each one is a shape the model produced in an
// actual past run that should NEVER pass again.
// ─────────────────────────────────────────────────────────────────────────
const REGRESSION_CASES = [
  {
    id: "regression-irregular-recurrence",
    bugContext: "Real bug: 3 separate LLM discovery candidates landed as recurrence=\"irregular\" with a perfectly good event_date attached, and every one was unapprovable because the app only ever displays \"weekly\" or \"dated\".",
    expectPass: false,
    candidate: {
      title: "Second Friday Family Night", source: "Broomfield Rec", city: "Broomfield",
      category: "rec", cost: "free", age_min: 0, age_max: 12,
      day_of_week: "Friday", start_time: "18:00", display_time: "6:00 PM",
      recurrence: "irregular", event_date: "2026-09-12", // should be "dated", not "irregular"
      note: "Monthly family night, second Friday of each month.",
      source_url: "https://example.com", confidence: "high"
    }
  },
  {
    id: "regression-comma-separated-days",
    bugContext: "Real bug caught on second run: \"Monday, Wednesday, Friday\" as one string in day_of_week, which the schema (and events table) can't represent -- needs to be split into one candidate per day, not caught here as-is.",
    expectPass: false,
    candidate: {
      title: "Open Gym Toddlers", source: "Erie Community Center", city: "Erie",
      category: "rec", cost: "paid", age_min: 1, age_max: 4,
      day_of_week: "Monday, Wednesday, Friday", // invalid -- must be a single day
      start_time: "09:00", display_time: "9:00 AM",
      recurrence: "weekly", event_date: "2026-09-08",
      note: "Open gym time for toddlers three mornings a week.",
      source_url: "https://example.com", confidence: "high"
    }
  },
  {
    id: "regression-weekly-skips-date-check",
    bugContext: "Second gap found 2026-08-09: old Broomfield instances got through again because the past-date check only ran inside the recurrence===\"dated\" branch -- a \"weekly\" candidate with an event_date already in the past slipped through entirely.",
    expectPass: false,
    candidate: {
      title: "Stale Weekly Storytime", source: "Old Listing Co", city: "Broomfield",
      category: "library", cost: "free", age_min: 0, age_max: 5,
      day_of_week: "Tuesday", start_time: "10:00", display_time: "10:00 AM",
      recurrence: "weekly",
      event_date: "2026-01-06", // long past -- must still be rejected even though recurrence is "weekly"
      note: "Weekly toddler storytime.", source_url: "https://example.com", confidence: "high"
    }
  }
];

function runStructuralEvals(cases, label) {
  console.log(`\n── ${label} ──`);
  let pass = 0;
  for (const c of cases) {
    const result = passesQueueBar(c.candidate);
    const ok = result.passes === c.expectPass;
    pass += ok ? 1 : 0;
    const status = ok ? "✅" : "❌";
    console.log(`${status} ${c.id}${c.bugContext ? `\n   context: ${c.bugContext}` : ""}`);
    if (!ok) {
      console.log(`   expected passesQueueBar to return passes=${c.expectPass}, got passes=${result.passes}`);
      if (result.reasons.length) console.log(`   reasons reported: ${result.reasons.join("; ")}`);
    }
  }
  console.log(`${label}: ${pass}/${cases.length} passed`);
  return { pass, total: cases.length };
}

// ─────────────────────────────────────────────────────────────────────────
// 3. LLM-AS-JUDGE EVAL -- for the free-text `note` field, where there's no
// single correct string. A second Claude call scores against a rubric.
// This is the kind of eval that would have caught, e.g., a fabricated
// product description or a note truncated mid-sentence -- failures no
// exact-match check can catch, because the text is superficially
// well-formed either way.
// ─────────────────────────────────────────────────────────────────────────
const JUDGE_CASES = [
  {
    id: "judge-good-note",
    candidate: {
      title: "Toddler Music Circle",
      note: "Sing-along circle time for toddlers and caregivers, no registration needed."
    },
    sourceContext: "Free weekly music circle for toddlers (ages 1-3) and their grown-ups. Drop in, no signup required. Songs, shakers, and movement."
  },
  {
    id: "judge-truncated-note",
    // Mirrors the real 300-char hard-truncation bug found and fixed today
    // in index.js -- a note that ends mid-word/mid-sentence.
    candidate: {
      title: "Toddler Explorers",
      note: "Toddlers explore and learn through hands-on activities that focus on creativity and fun. Boulder Public Library would like to thank everyone who has generously donated to the Boulder Library Foundation. Your financial support funds library programs such as Summe"
    },
    sourceContext: "Toddlers explore and learn through hands-on activities that focus on creativity and fun. Imaginations run wild while building foundational skills."
  },
  {
    id: "judge-fabricated-note",
    // Mirrors the real fabrication caught today -- a plausible-sounding
    // description that doesn't match what the source actually sells/offers.
    candidate: {
      title: "Best Day Ever Kids",
      note: "Ready-to-go activity kits for your next best day."
    },
    sourceContext: "Best Day Ever Kids is a boutique children's clothing brand selling pants, tops, dresses, and rompers for babies and toddlers."
  }
];

const JUDGE_RUBRIC = `You are grading a short event/business description for factual accuracy against its source context. Score it on a 1-5 scale:
5 = fully accurate, nothing fabricated, not truncated or cut off
3 = mostly accurate but has a minor issue (slightly vague, mildly awkward)
1 = fabricated, contradicts the source, or is visibly cut off mid-sentence/mid-word

Respond with ONLY a JSON object: {"score": number, "reason": "one sentence"}`;

async function callLLMJudge(apiKey, note, sourceContext) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 200,
      system: JUDGE_RUBRIC,
      messages: [{
        role: "user",
        content: `Source context:\n${sourceContext}\n\nDescription to grade:\n${note}`
      }]
    })
  });
  if (!res.ok) throw new Error(`Judge API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = (data.content || []).find((b) => b.type === "text")?.text || "";
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Judge didn't return parseable JSON: ${text.slice(0, 200)}`);
  return JSON.parse(match[0]);
}

async function runLLMJudgeEvals() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  console.log(`\n── LLM-as-judge evals ──`);
  if (!apiKey) {
    console.log("Skipped -- set ANTHROPIC_API_KEY to run this section.");
    console.log("(The structural and regression evals above don't need a key -- they're pure logic.)");
    return { pass: 0, total: 0, skipped: true };
  }
  let pass = 0;
  for (const c of JUDGE_CASES) {
    try {
      const { score, reason } = await callLLMJudge(apiKey, c.candidate.note, c.sourceContext);
      const ok = score >= 4; // threshold: only "fully accurate" counts as a pass
      pass += ok ? 1 : 0;
      console.log(`${ok ? "✅" : "❌"} ${c.id} -- score ${score}/5: ${reason}`);
    } catch (err) {
      console.log(`⚠️  ${c.id} -- judge call failed: ${err.message}`);
    }
  }
  console.log(`LLM-as-judge: ${pass}/${JUDGE_CASES.length} passed`);
  return { pass, total: JUDGE_CASES.length };
}

async function main() {
  console.log("Playroute discovery pipeline -- eval suite");
  console.log(`Testing against DISCOVERY_SYSTEM_PROMPT (${DISCOVERY_SYSTEM_PROMPT.length} chars) and CATEGORIES: ${CATEGORIES.join(", ")}`);

  const structural = runStructuralEvals(STRUCTURAL_CASES, "Structural evals");
  const regression = runStructuralEvals(REGRESSION_CASES, "Regression evals (real past bugs)");
  const judge = await runLLMJudgeEvals();

  const totalPass = structural.pass + regression.pass + judge.pass;
  const totalCases = structural.total + regression.total + judge.total;
  console.log(`\n=== OVERALL: ${totalPass}/${totalCases} passed${judge.skipped ? " (judge evals skipped)" : ""} ===`);
  console.log("Run this again after any change to DISCOVERY_SYSTEM_PROMPT or passesQueueBar to see what moved.");
}

main();
