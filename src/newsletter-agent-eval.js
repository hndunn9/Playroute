// Checks for the newsletter agent's pure helpers. Run: node src/newsletter-agent-eval.js
import { nextSendDate, isThursdayMT, variantFor, twoPropTest, summarizeResults, validateAgentDraft, parseAgentReply, verifyResendWebhook, buildAgentPrompt } from "./newsletter-agent.js";

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
}

// Send dates (Mountain Time). Oct 2026: Thu 15, Sun 18, Sun 25.
check("Thursday drafts the coming Sunday", nextSendDate(new Date("2026-10-15T09:00:00Z")) === "2026-10-18", nextSendDate(new Date("2026-10-15T09:00:00Z")));
check("Sunday 10am MT is today's issue", nextSendDate(new Date("2026-10-18T16:00:00Z")) === "2026-10-18");
check("Sunday 1pm MT moves to next week", nextSendDate(new Date("2026-10-18T19:00:00Z")) === "2026-10-25");
check("Saturday night MT is still Sunday's issue", nextSendDate(new Date("2026-10-18T04:30:00Z")) === "2026-10-18");
check("winter (MST) Sunday 10:30am is today", nextSendDate(new Date("2026-12-06T17:30:00Z")) === "2026-12-06");
check("isThursdayMT at the 09:00 UTC cron", isThursdayMT(new Date("2026-10-15T09:00:00Z")));
check("Wednesday 9pm MT is not Thursday", !isThursdayMT(new Date("2026-10-15T03:00:00Z")));

// Variant split: stable per issue, roughly even.
check("variant is stable", variantFor("a@b.co", 7) === variantFor("A@B.co", 7));
let b = 0;
for (let i = 0; i < 2000; i++) if (variantFor(`user${i}@x.com`, 3) === "B") b++;
check("split is roughly 50/50", b > 900 && b < 1100, `B=${b}`);

// Stats
const t1 = twoPropTest(10, 200, 30, 200);
check("big click gap reads as B ahead", t1.verdict.startsWith("B ahead"), JSON.stringify(t1));
const t2 = twoPropTest(10, 100, 11, 100);
check("tiny gap is no clear winner", t2.verdict === "no clear winner", JSON.stringify(t2));
check("no data is handled", twoPropTest(0, 0, 0, 0).p === null);
const sum = summarizeResults([{ variant: "A", sent: 100, delivered: 98, opened: 40, clicked: 9 }, { variant: "B", sent: 100, delivered: 99, opened: 45, clicked: 20 }]);
check("summary computes click rate", sum.variants.A.click_rate === 9.2 && !!sum.test, JSON.stringify(sum));

// Draft validation
const defaults = { candidateIds: [1, 2, 3, 4], defaultSpotlightIds: [1, 2], defaultSubject: "This week on Playroute — Oct 19–25", pastSubjects: ["Old subject"] };
const v1 = validateAgentDraft({ subject_a: "Pumpkins Saturday, storytime all week", subject_b: "What's on for the littles this week?", intro: "Fall is here.", spotlight_ids: [3, 99, 3, "4", 1, 2], test: { variable: "subject", hypothesis: "Specific beats generic" } }, defaults);
check("unknown and duplicate spotlight ids dropped, max 3", JSON.stringify(v1.spotlight_ids) === "[3,4,1]", JSON.stringify(v1.spotlight_ids));
check("subject test kept with B", v1.test_plan && v1.test_plan.variable === "subject" && v1.subject_b);
const v2 = validateAgentDraft({ subject_a: "Hi", test: { variable: "subject" } }, defaults);
check("subject test without B becomes no test", v2.test_plan === null && v2.subject_b === null);
const v3 = validateAgentDraft({ subject_a: "old SUBJECT" }, defaults);
check("repeated subject falls back to default", v3.subject_a === defaults.defaultSubject);
const v4 = validateAgentDraft({}, defaults);
check("empty reply gives a safe rules draft", v4.subject_a === defaults.defaultSubject && JSON.stringify(v4.spotlight_ids) === "[1,2]" && v4.test_plan === null);
const v5 = validateAgentDraft({ subject_a: "x".repeat(200), intro: "y".repeat(500), test: { variable: "bogus" } }, defaults);
check("lengths capped and unknown test ignored", v5.subject_a.length === 80 && v5.intro.length === 240 && v5.test_plan === null);
const v6 = validateAgentDraft({ subject_a: "S", intro: "One", intro_b: "Two", test: { variable: "intro", hypothesis: "h" } }, defaults);
check("intro test kept", v6.test_plan && v6.test_plan.variable === "intro" && v6.intro_b === "Two" && v6.subject_b === null);

check("reply JSON parsed out of prose", parseAgentReply('Sure!\n{"subject_a":"x"}\n').subject_a === "x");
const prompt = buildAgentPrompt({ send_date: "2026-10-18", week_label: "Oct 19–25", days: [] });
check("prompt forbids inventing details", /Never mention an event/.test(prompt.system));

// Webhook signature (Svix scheme), signed here with a known secret.
const secretBytes = new TextEncoder().encode("test-secret-0123456789");
const secret = "whsec_" + btoa(String.fromCharCode(...secretBytes));
const id = "msg_1", ts = String(Math.floor(Date.now() / 1000)), body = '{"type":"email.opened","data":{"email_id":"e1"}}';
const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
const sig = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${body}`)))));
check("valid signature accepted", await verifyResendWebhook(secret, { id, timestamp: ts, signature: `v1,bogus v1,${sig}` }, body));
check("tampered body rejected", !(await verifyResendWebhook(secret, { id, timestamp: ts, signature: `v1,${sig}` }, body + " ")));
check("old timestamp rejected", !(await verifyResendWebhook(secret, { id, timestamp: String(+ts - 3600), signature: `v1,${sig}` }, body)));
check("missing secret rejected", !(await verifyResendWebhook("", { id, timestamp: ts, signature: `v1,${sig}` }, body)));

console.log(`\n=== ${pass}/${pass + fail} passed ===`);
if (fail) process.exit(1);
