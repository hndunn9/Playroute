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
import { CATEGORIES, DISCOVERY_SYSTEM_PROMPT, passesQueueBar } from "./discovery-rules.js";

const DISCOVERY_MODEL = "claude-sonnet-5"; // confirm current model availability/pricing before relying on this long-term

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
//
// 7. UPDATE 2026-08-09: old Broomfield instances got through AGAIN despite
//    #6. Root cause: the past-date check only ran for recurrence==="dated"
//    -- anything classified "weekly" (correctly or not) skipped date
//    validation entirely, which is also why no concrete date was showing
//    up for review (none was required for weekly candidates). Fixed:
//    event_date is now required and past-date-checked for EVERY candidate
//    regardless of recurrence, the prompt now asks for the next real
//    occurrence date even on weekly things, and admin.html's pending list
//    now shows day_of_week alongside event_date so a reviewer sees both
//    the recurrence pattern and the concrete date to check it against.
//
// 8. UPDATE 2026-08-08 (later same day): 3 separate candidates (Lafayette
//    Art Night Out, Superior Summer Market, Superior Commons concert) all
//    landed as recurrence="irregular" despite each having a perfectly
//    good event_date -- and "irregular" is silently excluded from ever
//    showing an occurrence anywhere in this app, so all 3 were stuck
//    unapprovable despite being otherwise-complete, real events. The
//    prompt schema just listed "weekly" or "dated" or "irregular" with no
//    guidance on when to use which, so the model reached for "irregular"
//    for anything not strictly weekly (monthly patterns, annual events)
//    without knowing that classification was a dead end here. Removed
//    "irregular" from the schema entirely -- "dated" now explicitly covers
//    one-offs AND next-occurrence-of-a-non-weekly-pattern, which is all
//    event_date being mandatory already meant in practice. Added a code
//    backstop too (passesQueueBar rejects anything that isn't "weekly" or
//    "dated"), so this fails safe even if a future prompt tweak
//    accidentally reopens the gap. Verified against the exact 3 real
//    failures -- all 3 now blocked pre-queue instead of landing broken.
