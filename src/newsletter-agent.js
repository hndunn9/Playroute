// Weekly newsletter agent: pure helpers (no D1, no fetch) so they can be
// tested with `node src/newsletter-agent-eval.js`. The wiring (drafts table,
// Claude call, sending, webhooks, admin endpoints) lives in index.js.
//
// The loop: Thursday the agent drafts Sunday's issue (subject, intro,
// spotlight picks, one A/B test) -> owner reviews in admin > Newsletter ->
// Sunday's cron sends ONLY an approved draft; no approval = that week is
// skipped -> Resend webhooks record delivered/opened/clicked per variant ->
// next Thursday's draft gets those results as history.
//
// Event selection never changes here: the day-by-day list still comes from
// digest-rules.js. The agent only proposes the editorial layer.

export const NEWSLETTER_TZ = "America/Denver";
export const NEWSLETTER_MAX_SUBJECT = 80;
export const NEWSLETTER_MAX_INTRO = 240;
export const NEWSLETTER_TEST_VARIABLES = ["subject", "intro", "none"];

function mtParts(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: NEWSLETTER_TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hour12: false, weekday: "short"
  }).formatToParts(date);
  const p = Object.fromEntries(parts.filter((x) => x.type !== "literal").map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, hour: +p.hour % 24, weekday: p.weekday };
}

const pad = (n) => String(n).padStart(2, "0");

// Today's date in Mountain Time, YYYY-MM-DD.
export function mtDateStr(now = new Date()) {
  const { y, m, d } = mtParts(now);
  return `${y}-${pad(m)}-${pad(d)}`;
}

// The Sunday this draft is for. On a Sunday before noon MT that's today
// (the send cron runs at 11:00 MST / 12:00 MDT); otherwise the next Sunday.
export function nextSendDate(now = new Date()) {
  const { y, m, d, hour, weekday } = mtParts(now);
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);
  let add = (7 - dow) % 7;
  if (add === 0 && hour >= 12) add = 7;
  const t = new Date(Date.UTC(y, m - 1, d + add));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export function isThursdayMT(now = new Date()) {
  return mtParts(now).weekday === "Thu";
}

// Stable 50/50 split per issue: the same subscriber always lands in the
// same arm for a given draft, but arms reshuffle week to week.
export function variantFor(email, draftId) {
  let h = 0x811c9dc5;
  const s = `${draftId}:${String(email).toLowerCase()}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 2 === 0 ? "A" : "B";
}

function normCdf(z) {
  // Abramowitz-Stegun 7.1.26 erf approximation; plenty for a directional read.
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

// Two-proportion z-test, two-sided. Same reading convention as the app's
// Recommended A/B test: p < 0.20 (80% confidence) is a directional "win".
export function twoPropTest(x1, n1, x2, n2) {
  if (!n1 || !n2) return { p: null, z: null, verdict: "not enough data" };
  const p1 = x1 / n1, p2 = x2 / n2, pool = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(pool * (1 - pool) * (1 / n1 + 1 / n2));
  if (!se) return { p: 1, z: 0, verdict: "no difference" };
  const z = (p2 - p1) / se;
  const p = 2 * (1 - normCdf(Math.abs(z)));
  let verdict = "no clear winner";
  if (p < 0.2) verdict = p2 > p1 ? "B ahead (80% confidence)" : "A ahead (80% confidence)";
  return { p: Math.round(p * 1000) / 1000, z: Math.round(z * 100) / 100, verdict };
}

// Per-variant counts -> rates plus the test read on click rate
// (clicks / delivered). Opens are shown but not judged: Apple Mail Privacy
// Protection inflates them.
export function summarizeResults(rows) {
  const by = {};
  for (const r of rows || []) {
    const delivered = r.delivered || r.sent || 0;
    by[r.variant] = {
      sent: r.sent || 0, delivered: r.delivered || 0, opened: r.opened || 0, clicked: r.clicked || 0,
      open_rate: delivered ? Math.round((r.opened || 0) / delivered * 1000) / 10 : null,
      click_rate: delivered ? Math.round((r.clicked || 0) / delivered * 1000) / 10 : null
    };
  }
  let test = null;
  if (by.A && by.B) {
    const nA = by.A.delivered || by.A.sent, nB = by.B.delivered || by.B.sent;
    test = twoPropTest(by.A.clicked, nA, by.B.clicked, nB);
  }
  return { variants: by, test };
}

const clean = (s, max) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

// Turns the model's JSON into a draft that's safe to store. Anything
// missing or invalid falls back to the rules-based default rather than
// failing the draft.
export function validateAgentDraft(raw, { candidateIds, defaultSpotlightIds, defaultSubject, pastSubjects = [] }) {
  const out = {};
  const r = raw && typeof raw === "object" ? raw : {};
  out.subject_a = clean(r.subject_a, NEWSLETTER_MAX_SUBJECT) || defaultSubject;
  out.intro = clean(r.intro, NEWSLETTER_MAX_INTRO) || null;

  const allowed = new Set((candidateIds || []).map(Number));
  const ids = [];
  for (const id of Array.isArray(r.spotlight_ids) ? r.spotlight_ids : []) {
    const n = Number(id);
    if (allowed.has(n) && !ids.includes(n)) ids.push(n);
    if (ids.length >= 3) break;
  }
  out.spotlight_ids = ids.length ? ids : (defaultSpotlightIds || []).slice(0, 3);

  const t = r.test && typeof r.test === "object" ? r.test : {};
  let variable = NEWSLETTER_TEST_VARIABLES.includes(t.variable) ? t.variable : "none";
  out.subject_b = null;
  out.intro_b = null;
  if (variable === "subject") {
    out.subject_b = clean(r.subject_b, NEWSLETTER_MAX_SUBJECT) || null;
    if (!out.subject_b || out.subject_b === out.subject_a) variable = "none";
  } else if (variable === "intro") {
    out.intro_b = clean(r.intro_b, NEWSLETTER_MAX_INTRO) || null;
    if (!out.intro_b || out.intro_b === out.intro) variable = "none";
  }
  if (variable === "none") { out.subject_b = null; out.intro_b = null; }
  out.test_plan = variable === "none" ? null : {
    variable,
    hypothesis: clean(t.hypothesis, 300),
    metric: "click rate (unique clicks / delivered)"
  };
  out.rationale = clean(r.rationale, 1500) || null;
  out.last_issue_readout = clean(r.last_issue_readout, 800) || null;

  // Gmail threads identical subjects into one conversation. Keep each
  // week's subject unique.
  const seen = new Set(pastSubjects.map((s) => String(s || "").toLowerCase()));
  if (seen.has(out.subject_a.toLowerCase())) out.subject_a = defaultSubject;
  if (out.subject_b && seen.has(out.subject_b.toLowerCase())) { out.subject_b = null; out.test_plan = null; }
  return out;
}

export function buildAgentPrompt(input) {
  const system = `You are the editor of Playroute's weekly email: free and low-cost things to do with young kids (mostly under 6) in Boulder County, Colorado. The list is written by a local parent. Voice: warm, plain, specific, a little dry. No hype, no exclamation-point pileups, at most one emoji in a subject line, no clickbait.

You only write the editorial layer. The day-by-day event list is fixed by rules you can't change. Never mention an event, venue, day or detail that isn't in the input, and never invent prices, ages or descriptions.

Your job each week:
1. subject_a: the subject line (under 60 characters ideally, ${NEWSLETTER_MAX_SUBJECT} max). Name one or two concrete things happening this week. It must differ from every past subject.
2. intro: one or two sentences (${NEWSLETTER_MAX_INTRO} chars max) under "This week on Playroute".
3. spotlight_ids: up to 3 event ids from spotlight_candidates for the "Don't miss these" section. Prefer variety of category and venue, one-off or seasonal events, and trending ones.
4. test: exactly one A/B test, or none. variable is "subject" (then give subject_b) or "intro" (then give intro_b) or "none". Test one clear idea (e.g. naming a specific event vs. naming the day; a question vs. a statement). Build on what history shows: don't re-run an idea that lost, and try to confirm or extend one that won. The metric is click rate; the list is small, so prefer bold, clearly different variants.
5. last_issue_readout: 1-3 plain sentences on the most recent sent issue's results from history. Results are directional only (small list; opens are inflated by Apple Mail, so judge clicks). Don't call a winner unless the provided verdict says so. Say "no sent issues yet" if history is empty.
6. rationale: 2-4 sentences explaining your choices for the owner, who approves the draft.

Reply with only a JSON object:
{"subject_a":"","subject_b":"","intro":"","intro_b":"","spotlight_ids":[],"test":{"variable":"subject|intro|none","hypothesis":""},"last_issue_readout":"","rationale":""}`;
  const user = `Issue goes out Sunday ${input.send_date} (covers ${input.week_label}).

INPUT:
${JSON.stringify(input)}`;
  return { system, user };
}

// Pulls the first JSON object out of the model's reply.
export function parseAgentReply(text) {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`No JSON in agent reply: ${String(text).slice(0, 200)}`);
  return JSON.parse(m[0]);
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes) {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin);
}

// Resend signs webhooks with Svix: HMAC-SHA256 over "id.timestamp.body"
// using the base64 secret after "whsec_". The signature header can hold
// several space-separated "v1,<base64>" entries (during secret rotation).
export async function verifyResendWebhook(secret, { id, timestamp, signature }, body, nowMs = Date.now()) {
  if (!secret || !id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > 300) return false;
  const key = await crypto.subtle.importKey(
    "raw", b64ToBytes(String(secret).replace(/^whsec_/, "")),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
  const expected = bytesToB64(mac);
  return String(signature).split(" ").some((part) => {
    const [ver, sig] = part.split(",");
    if (ver !== "v1" || !sig || sig.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
  });
}

// Resend event type -> what we store. Anything else is ignored.
export const RESEND_EVENT_TYPES = {
  "email.delivered": "delivered",
  "email.opened": "opened",
  "email.clicked": "clicked",
  "email.bounced": "bounced",
  "email.complained": "complained"
};
