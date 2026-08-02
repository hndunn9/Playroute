// src/discovery-workflow.js
//
// Weekly LLM-driven event discovery. Different in kind from the scrapers in
// index.js: those know exactly which page to fetch and what shape the data
// is in. This instead asks Claude (with live web search) to actively go
// find family activity providers in a given city that AREN'T already in
// Playroute -- genuine discovery, not re-scraping a known URL.
//
// Built as a Cloudflare Workflow rather than folded into the existing
// scheduled() cron handler because this is qualitatively slower and less
// predictable than the existing scrapers (a live web-search-backed LLM call
// vs. a single fetch()), and Workflows give per-step retries and durable
// state for exactly that kind of task -- if the LLM call fails transiently,
// the step retries without re-running the whole discovery from scratch.
//
// Funnels through the SAME ingestCandidate() every other source uses --
// same validation, same dedup, same pending_events review queue. Nothing
// here bypasses human review; the only thing "automated" is finding
// candidates in the first place.
//
// REQUIRES: an ANTHROPIC_API_KEY secret (wrangler secret put ANTHROPIC_API_KEY)
// and a [[workflows]] binding in wrangler.jsonc (see bottom of this file for
// the exact config to add). Neither exists yet as of writing this -- see the
// deploy checklist in the PR/commit message.

import { WorkflowEntrypoint } from "cloudflare:workers";
import { ingestCandidate } from "./pipeline.js";

const DISCOVERY_MODEL = "claude-sonnet-5"; // confirm current model availability/pricing before relying on this long-term
const CATEGORIES = ["library", "rec", "museum", "outdoor", "community", "farmers_market"];

// Picks whichever registered city has gone longest without a discovery run
// (or has never run at all -- NULL last_run_at sorts first). Verified
// against live data before this was written: correctly returns the
// never-run city first, then cycles by recency once all have run once.
async function pickNextCity(env) {
  const row = await env.DB.prepare(
    `SELECT id, city FROM scrape_sources
     WHERE source_key LIKE 'llm_discovery_%' AND enabled = 1
     ORDER BY (last_run_at IS NOT NULL), last_run_at ASC
     LIMIT 1`
  ).first();
  return row; // { id, city } or null if none registered/enabled
}

// What Playroute already has for this city, so the prompt can explicitly
// tell Claude what NOT to rediscover. Keeps this compact (distinct source
// names only, not full event listings) since it just needs to be enough
// context to avoid obvious re-finds, not a complete inventory dump.
async function fetchExistingSources(env, city) {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT source FROM events WHERE city = ? ORDER BY source`
  ).bind(city).all();
  return results.map((r) => r.source).filter(Boolean);
}

const DISCOVERY_SYSTEM_PROMPT = `You are a research assistant finding family/kids activities for a local events app called Playroute, covering Boulder County and nearby Colorado cities.

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
  "day_of_week": string (e.g. "Tuesday") -- required unless recurrence is "dated", in which case use the actual weekday of event_date,
  "start_time": "HH:MM" 24-hour -- a REAL time from the source page, never a placeholder,
  "display_time": string (human-readable, e.g. "10:00 AM"),
  "recurrence": "weekly" or "dated" or "irregular",
  "event_date": "YYYY-MM-DD", required and must be today or later if recurrence is "dated", else null,
  "note": string (2-3 sentence summary a parent would actually want to read),
  "source_url": string (the actual specific page you found the schedule on, not a homepage),
  "confidence": "high" or "low" -- be honest here. If you'd put "low", strongly consider just leaving the candidate out instead, per the strict bar above.
}

Return an empty array if nothing genuinely clears the bar. That is a good, useful result, not a failure.`;

// The actual Anthropic API call. NOTE: this code is written carefully
// against documented API patterns (web_search server tool + a final
// JSON-code-block response) but has NOT been live-tested end-to-end --
// this sandbox has no ANTHROPIC_API_KEY available to call the real API
// with. Treat the first few real runs as a trial, not a fire-and-forget --
// check the pending_events results by hand before trusting the cadence.
async function discoverEvents(env, city, existingSources) {
  const userMessage = `City: ${city}, Colorado

Providers Playroute already has for this city (do not rediscover these):
${existingSources.length ? existingSources.map((s) => `- ${s}`).join("\n") : "(none yet)"}

Find genuinely new family/kids activity providers or events for this city.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: DISCOVERY_MODEL,
      max_tokens: 4096,
      system: DISCOVERY_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }]
    })
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${body.slice(0, 500)}`);
  }
  const data = await res.json();

  // Concatenate all text blocks in the final response -- with web search,
  // the response can interleave text and tool_use/tool_result blocks, but
  // the final JSON code block should be in one of the text blocks.
  const textContent = (data.content || [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  const jsonMatch = textContent.match(/```json\s*([\s\S]*?)\s*```/);
  if (!jsonMatch) {
    throw new Error(`No JSON code block found in Claude's response. Raw text: ${textContent.slice(0, 500)}`);
  }

  let candidates;
  try {
    candidates = JSON.parse(jsonMatch[1]);
  } catch (e) {
    throw new Error(`Failed to parse JSON from Claude's response: ${e.message}. Raw block: ${jsonMatch[1].slice(0, 500)}`);
  }
  if (!Array.isArray(candidates)) {
    throw new Error(`Expected a JSON array, got: ${typeof candidates}`);
  }
  return candidates;
}

// Hard bar a candidate must clear before it's even worth a human looking
// at it. Real gap found on the first live test run (2026-08-02): every
// candidate that landed in pending_events was missing day_of_week and/or
// start_time, one was a date that had already passed, and validateCandidate
// correctly flagged all of this -- but ingestCandidate still QUEUES
// error-severity candidates (right behavior for the other scrapers, where
// a human already vetted the underlying source; wrong here, where the LLM
// itself is the uncertain part). This filter runs BEFORE ingestCandidate,
// so genuinely incomplete or unconfirmed candidates never reach the review
// queue as reject-only clutter in the first place.
function passesQueueBar(ev) {
  const reasons = [];
  if (!ev.title || !ev.source || !ev.city || !ev.category || !ev.cost) {
    reasons.push("missing a core field (title/source/city/category/cost)");
  }
  if (!ev.start_time || !/^\d{1,2}:\d{2}$/.test(ev.start_time)) {
    reasons.push("no real start_time");
  }
  if (!ev.display_time || /check listing|see source|tbd/i.test(ev.display_time)) {
    reasons.push("display_time is a placeholder, not a real time");
  }
  if (ev.recurrence === "dated") {
    if (!ev.event_date) {
      reasons.push('recurrence is "dated" but event_date is missing');
    } else {
      const d = new Date(`${ev.event_date}T00:00:00`);
      if (isNaN(d.getTime())) reasons.push("event_date isn't a valid date");
      else if (d < new Date(new Date().toDateString())) reasons.push("event_date is already in the past");
    }
  } else if (!ev.day_of_week) {
    reasons.push("not dated, but day_of_week is missing");
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

export class EventDiscoveryWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const target = await step.do("pick-city", async () => {
      const forcedCity = event.payload && event.payload.city;
      if (forcedCity) {
        const row = await this.env.DB.prepare(
          `SELECT id, city FROM scrape_sources WHERE source_key = ?`
        ).bind(`llm_discovery_${forcedCity.toLowerCase()}`).first();
        if (!row) throw new Error(`No registered llm_discovery source for city "${forcedCity}"`);
        return row;
      }
      const row = await pickNextCity(this.env);
      if (!row) throw new Error("No llm_discovery_* sources registered in scrape_sources");
      return row;
    });

    const existingSources = await step.do("fetch-existing-inventory", async () => {
      return await fetchExistingSources(this.env, target.city);
    });

    const candidates = await step.do(
      "discover-via-llm",
      { retries: { limit: 2, delay: "30 seconds", backoff: "exponential" }, timeout: "5 minutes" },
      async () => {
        return await discoverEvents(this.env, target.city, existingSources);
      }
    );

    const result = await step.do("validate-and-queue", async () => {
      const sourceRow = {
        id: target.id,
        source_key: `llm_discovery_${target.city.toLowerCase()}`,
        city: target.city,
        platform: "LLM Discovery",
        confidence: "review"
      };
      let queued = 0, skippedDuplicate = 0, droppedLowBar = 0, errors = [];
      const dropped = [];
      for (const raw of candidates) {
        try {
          const ev = { ...raw };
          delete ev.confidence; // not a real events-table column, just an LLM self-assessment signal

          const bar = passesQueueBar(raw); // check against the ORIGINAL raw candidate, before confidence is stripped
          if (!bar.passes) {
            droppedLowBar++;
            dropped.push({ title: raw.title, reasons: bar.reasons });
            continue; // never reaches ingestCandidate / pending_events at all
          }

          const res = await ingestCandidate(this.env, sourceRow, ev);
          if (res.reason === "duplicate-in-events") { skippedDuplicate++; continue; }
          if (res.queued) queued++;
        } catch (e) {
          errors.push({ title: raw.title, error: String(e) });
        }
      }
      await this.env.DB.prepare(
        `UPDATE scrape_sources SET last_run_at = CURRENT_TIMESTAMP, last_run_status = ?, last_error = ?, last_found = ? WHERE id = ?`
      ).bind(
        errors.length ? "partial_error" : "ok",
        errors.length ? JSON.stringify(errors).slice(0, 1000) : null,
        candidates.length,
        target.id
      ).run();
      return { city: target.city, found: candidates.length, queued, skippedDuplicate, droppedLowBar, dropped, errors };
    });

    return result;
  }
}

// --- Deploy checklist (nothing below this line runs -- it's setup notes) --
//
// 1. wrangler secret put ANTHROPIC_API_KEY
//    (get a real API key from console.anthropic.com -- this is billed
//    separately from your Claude.ai/Claude Code usage)
//
// 2. Add to wrangler.jsonc:
//    "workflows": [
//      {
//        "name": "event-discovery",
//        "binding": "EVENT_DISCOVERY_WORKFLOW",
//        "class_name": "EventDiscoveryWorkflow"
//      }
//    ]
//
// 3. Export EventDiscoveryWorkflow from src/index.js (or keep this as a
//    separate entry -- Workflows classes need to be reachable from your
//    main module's exports, check current Workflows docs for the exact
//    multi-file export pattern since this may have changed since writing).
//
// 4. To trigger manually (e.g. an admin panel button):
//      await env.EVENT_DISCOVERY_WORKFLOW.create();
//    or forced to a specific city:
//      await env.EVENT_DISCOVERY_WORKFLOW.create({ params: { city: "Boulder" } });
//
// 5. To trigger weekly: add a new cron trigger distinct from the existing
//    ones (e.g. a different day/time than the Sunday digest crons, so a
//    slow discovery run can never contend with or delay the newsletter),
//    and in the scheduled() handler's matching branch:
//      await env.EVENT_DISCOVERY_WORKFLOW.create();
//
// 6. UPDATE 2026-08-02: first live test run found real problems -- every
//    candidate queued was missing day_of_week/start_time, one had a past
//    event_date, and at least one didn't correspond to anything real. Fixed
//    with passesQueueBar() (a hard pre-queue gate, checked BEFORE
//    ingestCandidate -- incomplete/unconfirmed/past candidates never reach
//    pending_events at all now) and a stricter system prompt pushing the
//    model to leave things out rather than guess. Verified the new filter
//    against the exact 4 bad candidates from that real run -- all 4 now
//    correctly blocked. Still worth watching the next several runs by hand;
//    this reduces garbage, it doesn't guarantee zero.
