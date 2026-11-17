// Playroute+ server helpers: node evals/plus-eval.js (exits 1 on failure).
// Covers the parts that guard money and identity: Stripe webhook signature
// checks, the signed member cookie, Stripe form encoding and member status.
import { _test } from "../src/plus.js";
const { formEncode, periodEndIso, isActiveMember, normEmail, verifyStripeSignature, memberCookies, memberEmailFromCookie, hmacHex } = _test;

let failed = 0;
const ok = (cond, name) => { console.log(`${cond ? "✓" : "✗"} ${name}`); if (!cond) failed++; };
const req = (headers) => ({ headers: { get: (k) => headers[k] ?? null } });

// formEncode: Stripe's bracket syntax
ok(formEncode({ mode: "subscription", line_items: { 0: { price: "price_1", quantity: 1 } }, skip: undefined })
  === "mode=subscription&line_items%5B0%5D%5Bprice%5D=price_1&line_items%5B0%5D%5Bquantity%5D=1", "formEncode nests with brackets and drops undefined");

// periodEndIso: old (top-level) and new (item-level) API shapes
ok(periodEndIso({ current_period_end: 1800000000 }) === "2027-01-15T08:00:00.000Z", "period end from subscription");
ok(periodEndIso({ items: { data: [{ current_period_end: 1800000000 }] } }) === "2027-01-15T08:00:00.000Z", "period end from subscription item");
ok(periodEndIso({}) === null, "no period end -> null");

// isActiveMember
const future = new Date(Date.now() + 30 * 86400000).toISOString();
const longAgo = new Date(Date.now() - 10 * 86400000).toISOString();
const yesterday = new Date(Date.now() - 86400000).toISOString();
ok(isActiveMember({ status: "active", current_period_end: future }), "active in period");
ok(isActiveMember({ status: "past_due", current_period_end: future }), "past_due keeps access (Stripe retries)");
ok(isActiveMember({ status: "active", current_period_end: yesterday }), "1 day past period end still in 3-day grace");
ok(!isActiveMember({ status: "active", current_period_end: longAgo }), "10 days past period end locks");
ok(!isActiveMember({ status: "canceled", current_period_end: future }), "canceled locks");
ok(!isActiveMember({ status: "refunded", current_period_end: future }), "refunded locks");
ok(!isActiveMember(null), "no row locks");

// normEmail
ok(normEmail("  Parent@Example.COM ") === "parent@example.com", "email trimmed + lowercased");
ok(normEmail("not-an-email") === null && normEmail("") === null, "bad email rejected");

// Stripe signature
const env = { STRIPE_WEBHOOK_SECRET: "whsec_test", PLUS_COOKIE_SECRET: "cookie-secret-for-tests" };
const body = '{"type":"checkout.session.completed"}';
const t = Math.floor(Date.now() / 1000);
const good = await hmacHex(env.STRIPE_WEBHOOK_SECRET, `${t}.${body}`);
ok(await verifyStripeSignature(env, req({ "Stripe-Signature": `t=${t},v1=${good}` }), body), "valid signature accepted");
ok(await verifyStripeSignature(env, req({ "Stripe-Signature": `t=${t},v1=deadbeef,v1=${good}` }), body), "any matching v1 accepted (secret rotation)");
ok(!(await verifyStripeSignature(env, req({ "Stripe-Signature": `t=${t},v1=${good}` }), body + " ")), "tampered body rejected");
const old = t - 600;
const oldSig = await hmacHex(env.STRIPE_WEBHOOK_SECRET, `${old}.${body}`);
ok(!(await verifyStripeSignature(env, req({ "Stripe-Signature": `t=${old},v1=${oldSig}` }), body)), "10-minute-old signature rejected");
ok(!(await verifyStripeSignature(env, req({}), body)), "missing header rejected");
ok(!(await verifyStripeSignature({}, req({ "Stripe-Signature": `t=${t},v1=${good}` }), body)), "missing secret rejected");

// Member cookie round trip + tampering
const [member, hint] = await memberCookies(env, "parent@example.com");
ok(/HttpOnly/.test(member) && /Secure/.test(member) && !/HttpOnly/.test(hint), "member cookie HttpOnly, hint readable");
const value = member.split(";")[0].split("=").slice(1).join("=");
ok(await memberEmailFromCookie(req({ Cookie: `x=1; pr_plus=${value}` }), env) === "parent@example.com", "cookie round trip");
const [payload, sig] = value.split(".");
const forged = Buffer.from("someone@else.com").toString("base64url");
ok(await memberEmailFromCookie(req({ Cookie: `pr_plus=${forged}.${sig}` }), env) === null, "swapped email rejected");
ok(await memberEmailFromCookie(req({ Cookie: `pr_plus=${payload}.${sig.slice(0, -1)}0` }), env) === null || sig.endsWith("0"), "bad signature rejected");
ok(await memberEmailFromCookie(req({ Cookie: `pr_plus=${value}` }), { PLUS_COOKIE_SECRET: "other" }) === null, "other secret rejected");

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
