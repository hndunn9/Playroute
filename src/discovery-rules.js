// src/discovery-rules.js
//
// Pure logic for the LLM discovery pipeline -- deliberately has ZERO
// imports from "cloudflare:workers" or anything else Workers-runtime-only.
// That's the whole point of this file existing separately from
// discovery-workflow.js: passesQueueBar/CATEGORIES/DISCOVERY_SYSTEM_PROMPT
// need to be testable by a plain `node` process (see evals/discovery-eval.js)
// without spinning up wrangler/miniflare just to check business logic that
// has nothing to do with Workflows, KV, or D1 bindings.

export const CATEGORIES = ["library", "rec", "museum", "outdoor", "community", "farmers_market"];

export const DISCOVERY_SYSTEM_PROMPT = `You are a research assistant finding family/kids activities for a local events app called Playroute, covering Boulder County and nearby Colorado cities.

Given a city and a list of providers/venues Playroute ALREADY has, use web search to find providers, classes, drop-ins, or recurring programs for kids/families in that city that are NOT already in the existing list.

STRICT BAR FOR INCLUSION -- read this carefully, it directly determines what gets returned:
- Only include something if you found a SPECIFIC page (not a homepage, not a general "programs" listing) that states its actual day/date AND time. If the best you found is "check our site for current schedule" or similar, LEAVE IT OUT rather than including it with a placeholder.
- Only include something if you are confident it currently, actually exists and runs on the schedule you found -- not something you're inferring a venue "probably" offers based on its general description, and not something whose page might be stale/outdated. If you have any real doubt, leave it out.
- Do not include anything with an event_date in the past relative to today.
- It is far better to return FEWER, fully-confirmed candidates than to pad the list with plausible-sounding but unconfirmed ones. An empty array is a completely acceptable, honest result if nothing clears this bar -- do not include something just to have something to show.

Do not invent details to fill in a field. If you cannot find a specific value with real confidence, leave that candidate out entirely rather than guessing -- there is no partial credit here, an incomplete candidate is worse than no candidate, since a human still has to spend time reviewing and rejecting it.

When you're done searching, respond with ONLY a JSON code block (\`\`\`json ... \`\`\`) containing an array of candidates. No other text before or after the code block. Each candidate object must have exactly these fields, ALL of them populated with real, confirmed values (not null, not "unknown", not a placeholder -- if you can't fill every field with confidence, don't include that candidate at all):

{
  "title": string,
  "source": string (organization/venue name),
  "city": string,
  "category": one of ${JSON.stringify(CATEGORIES)},
  "cost": "free" or "paid",
  "age_min": number,
  "age_max": number,
  "day_of_week": string (e.g. "Tuesday") -- required unless recurrence is "dated", in which case use the actual weekday of event_date. Must be exactly ONE day name. If something runs on multiple days per week (e.g. Mon/Wed/Fri), return it as SEPARATE candidates, one per day -- do not combine days into one string like "Monday, Wednesday, Friday",
  "start_time": "HH:MM" 24-hour -- a REAL time from the source page, never a placeholder,
  "display_time": string (human-readable, e.g. "10:00 AM"),
  "recurrence": "weekly" or "dated" -- only these two. Use "dated" for both true one-off events AND anything on a monthly/annual/other non-weekly pattern (e.g. "second Friday of the month", an annual festival) -- give event_date as the next real upcoming occurrence you found. Do NOT use any other value here (e.g. "irregular") -- this app has no way to display anything outside these two, so a candidate with any other recurrence value will never actually show up if approved, no matter how complete the rest of its fields are,
  "event_date": "YYYY-MM-DD" -- REQUIRED for every candidate. For "dated", this is the actual date (the one-time date, or the next real occurrence if it's a recurring-but-not-weekly pattern). For "weekly", this is the NEXT real upcoming occurrence date you can find or calculate (e.g. if it's every Tuesday and today is a Wednesday, give next Tuesday's date). This must always be today or later -- never a date that has already passed. If you cannot pin down a specific next occurrence date with confidence, leave the candidate out entirely rather than guessing one,
  "note": string (2-3 sentence summary a parent would actually want to read),
  "source_url": string (the actual specific page you found the schedule on, not a homepage),
  "confidence": "high" or "low" -- be honest here. If you'd put "low", strongly consider just leaving the candidate out instead, per the strict bar above.
}

Return an empty array if nothing genuinely clears the bar. That is a good, useful result, not a failure.`;

// FIRST GAP (original bug): validateCandidate correctly flagged incomplete
// LLM output (missing start_time, a past event_date, etc.) but
// ingestCandidate still QUEUES error-severity candidates -- right behavior
// for the other scrapers, where a human already vetted the underlying
// source; wrong here, where the LLM itself is the uncertain part. This
// filter runs BEFORE ingestCandidate, so genuinely incomplete or
// unconfirmed candidates never reach the review queue as reject-only
// clutter in the first place.
//
// SECOND GAP found 2026-08-09: old Broomfield instances got through AGAIN
// after the first fix. Root cause -- the event_date / past-date checks
// below only ran inside the `recurrence === "dated"` branch. Anything the
// model classified as "weekly" (whether correctly or not) skipped date
// validation entirely, AND never surfaced a concrete date for a human to
// even check against in the review queue -- both complaints were the same
// bug. Fixed by requiring event_date and validating it's not in the past
// for every candidate regardless of claimed recurrence, and by having the
// prompt always ask for the next real upcoming occurrence date even for
// weekly things (see DISCOVERY_SYSTEM_PROMPT above).
export function passesQueueBar(ev) {
  const reasons = [];
  if (!ev.title || !ev.source || !ev.city || !ev.category || !ev.cost) {
    reasons.push("missing a core field (title/source/city/category/cost)");
  }
  // Backstop for the prompt guidance above -- this app silently excludes
  // any recurrence value other than "weekly"/"dated" from ever showing an
  // occurrence at all (confirmed real bug: 3 separate LLM discovery
  // candidates landed as "irregular" with a perfectly good event_date
  // attached, and every one of them was unapprovable as a result). If the
  // model ever ignores the prompt instruction, this catches it here
  // instead of it reaching pending_events broken again.
  if (ev.recurrence !== "weekly" && ev.recurrence !== "dated") {
    reasons.push(`recurrence "${ev.recurrence}" isn't supported by this app (only "weekly" or "dated" ever show up) -- reclassify as "dated" if a specific event_date was found`);
  }
  if (!ev.start_time || !/^\d{1,2}:\d{2}$/.test(ev.start_time)) {
    reasons.push("no real start_time");
  }
  if (!ev.display_time || /check listing|see source|tbd/i.test(ev.display_time)) {
    reasons.push("display_time is a placeholder, not a real time");
  }
  // Unconditional now -- every candidate must carry a concrete, checkable
  // date, whether it's a one-off ("dated") or the next occurrence of a
  // recurring thing ("weekly"/"irregular"). This is what actually shows up
  // in the pending-review UI for a human to verify against.
  if (!ev.event_date) {
    reasons.push("event_date is missing (required for every candidate now, not just dated ones)");
  } else {
    const d = new Date(`${ev.event_date}T00:00:00`);
    if (isNaN(d.getTime())) reasons.push("event_date isn't a valid date");
    else if (d < new Date(new Date().toDateString())) reasons.push("event_date is already in the past");
  }
  if (ev.recurrence !== "dated") {
    const VALID_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    if (!ev.day_of_week) {
      reasons.push("not dated, but day_of_week is missing");
    } else if (!VALID_DAYS.includes(ev.day_of_week)) {
      // Real bug caught on the second run: "Monday, Wednesday, Friday" as
      // one string -- a multi-day thing needs to be multiple candidates
      // (one per day), not one candidate with a comma-separated field the
      // rest of the schema (and the events table) can't represent.
      reasons.push(`day_of_week "${ev.day_of_week}" isn't a single valid weekday (e.g. multi-day strings like "Mon, Wed, Fri" aren't supported -- that needs one candidate per day)`);
    }
  }
  if (!ev.source_url || !/^https?:\/\//.test(ev.source_url)) {
    reasons.push("no real source_url");
  }
  // The LLM's own confidence self-assessment. Deliberately strict: "low"
  // is dropped outright rather than queued-with-a-warning, because unlike
  // the scrapers (where low confidence means "the parsing might be off"),
  // here it can mean "I'm not fully sure this real-world thing exists" --
  // a real fabrication risk seen on the first test run.
  if (ev.confidence !== "high") {
    reasons.push(`self-reported confidence is "${ev.confidence || "unset"}", not "high"`);
  }
  return { passes: reasons.length === 0, reasons };
}
