// ── Playroute+ paid pilot (2026-11) ──
// $20/year subscription that unlocks events more than 7 days out. The blur
// itself is client-side (public/index.html, FEATURE_PLUS_ENABLED); this module
// is the money and identity side:
//
//   POST /api/plus/checkout   -> Stripe Checkout Session (subscription), returns {url}
//   GET  /plus/success        -> confirms the session with Stripe, stores the
//                                member, sets the member cookie, redirects home
//   POST /api/stripe-webhook  -> keeps plus_subscribers in sync (renewals,
//                                cancellations, failed payments, refunds)
//   GET  /api/plus/me         -> member status for the cookie holder
//   POST /api/plus/signin     -> emails a one-time sign-in link (Resend)
//   GET  /plus/login          -> redeems the link, sets the member cookie
//   POST /api/plus/portal     -> Stripe customer portal (manage / cancel)
//   POST /api/plus/signout    -> clears the member cookie
//   POST /api/plus/event      -> funnel step log (first time per browser per step)
//   GET  /api/plus-experiment -> admin results (edge-cached in index.js)
//
// Secrets (wrangler secret put …): STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
// PLUS_COOKIE_SECRET. Variable: STRIPE_PRICE_ID. Email reuses RESEND_API_KEY +
// DIGEST_FROM. Test-mode keys work end to end with Stripe's test cards.
// Tables: migrations/2026-11-17-plus-pilot.sql.

const PLUS_COOKIE = "pr_plus";          // HttpOnly, signed: who the member is
const PLUS_HINT_COOKIE = "pr_plus_hint"; // readable "1": tells the app to ask /api/plus/me
const PLUS_COOKIE_MAX_AGE = 400 * 24 * 60 * 60;
const LOGIN_TOKEN_MINUTES = 30;
const MEMBER_STATUSES = new Set(["active", "trialing", "past_due"]);
const FUNNEL_STEPS = new Set(["assigned", "exposed", "unlock_tap", "checkout_start", "purchased", "signin_request", "not_now", "why_subscribe"]);
const ARMS = new Set(["plus", "control"]);

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};
function json(data, status = 200, extra = {}) {
  const headers = new Headers({ ...HEADERS, "Cache-Control": "no-store" });
  for (const [k, v] of Object.entries(extra)) {
    if (Array.isArray(v)) v.forEach(x => headers.append(k, x)); else headers.set(k, v);
  }
  return Response.json(data, { status, headers });
}
function redirect(location, cookies = []) {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  cookies.forEach(c => headers.append("Set-Cookie", c));
  return new Response(null, { status: 302, headers });
}
function readCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) {
      try { return decodeURIComponent(part.slice(i + 1)); } catch { return null; }
    }
  }
  return null;
}
function firstSeenId(request) {
  const m = /^([a-f0-9]{32})\./.exec(readCookie(request, "pr_fs") || "");
  return m ? m[1] : null;
}
function normEmail(e) {
  const s = String(e || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 200 ? s : null;
}

// ── crypto helpers ──
const enc = new TextEncoder();
const toHex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
const b64url = s => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = s => atob(s.replace(/-/g, "+").replace(/_/g, "/"));
async function hmacHex(secret, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}
async function sha256Hex(data) { return toHex(await crypto.subtle.digest("SHA-256", enc.encode(data))); }
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function randomToken(bytes = 32) {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

// ── member cookie ──
// Value: base64url(email) "." HMAC(email). The cookie only says WHO; whether
// they're still paying is checked in D1 on every /api/plus/me, so a refund
// or cancellation takes effect without touching the cookie.
async function memberCookies(env, email) {
  const payload = b64url(unescape(encodeURIComponent(email)));
  const sig = await hmacHex(env.PLUS_COOKIE_SECRET, payload);
  return [
    `${PLUS_COOKIE}=${payload}.${sig}; Max-Age=${PLUS_COOKIE_MAX_AGE}; Path=/; Secure; HttpOnly; SameSite=Lax`,
    `${PLUS_HINT_COOKIE}=1; Max-Age=${PLUS_COOKIE_MAX_AGE}; Path=/; Secure; SameSite=Lax`,
  ];
}
function clearMemberCookies() {
  return [
    `${PLUS_COOKIE}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`,
    `${PLUS_HINT_COOKIE}=; Max-Age=0; Path=/; Secure; SameSite=Lax`,
  ];
}
async function memberEmailFromCookie(request, env) {
  const raw = readCookie(request, PLUS_COOKIE);
  if (!raw || !env.PLUS_COOKIE_SECRET) return null;
  const dot = raw.lastIndexOf(".");
  if (dot < 1) return null;
  const payload = raw.slice(0, dot), sig = raw.slice(dot + 1);
  if (!safeEqual(sig, await hmacHex(env.PLUS_COOKIE_SECRET, payload))) return null;
  try { return normEmail(decodeURIComponent(escape(unb64url(payload)))); } catch { return null; }
}
async function getSubscriber(env, email) {
  return env.DB.prepare(`SELECT * FROM plus_subscribers WHERE email = ?`).bind(email).first();
}
function isActiveMember(sub) {
  if (!sub || !MEMBER_STATUSES.has(sub.status)) return false;
  // Grace: a missing or stale period end (e.g. a missed webhook) doesn't lock
  // a payer out for 3 days past it.
  if (!sub.current_period_end) return true;
  return Date.parse(sub.current_period_end) + 3 * 86400000 > Date.now();
}

// ── Stripe ──
function formEncode(obj, prefix = "", out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") formEncode(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out.join("&");
}
async function stripe(env, method, path, params) {
  if (!env.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY is not set");
  const init = { method, headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } };
  let url = `https://api.stripe.com/v1${path}`;
  if (params && method === "GET") url += `?${formEncode(params)}`;
  else if (params) {
    init.headers["Content-Type"] = "application/x-www-form-urlencoded";
    init.body = formEncode(params);
  }
  const res = await fetch(url, init);
  const data = await res.json();
  if (!res.ok) throw new Error(`Stripe ${path}: ${data?.error?.message || res.status}`);
  return data;
}
// Stripe moved current_period_end onto subscription items in newer API
// versions; read whichever is present.
function periodEndIso(sub) {
  const t = sub?.current_period_end ?? sub?.items?.data?.[0]?.current_period_end;
  return t ? new Date(t * 1000).toISOString() : null;
}
async function upsertFromSubscription(env, { email, customerId, sub, fsId, arm, livemode }) {
  await env.DB.prepare(
    `INSERT INTO plus_subscribers (email, stripe_customer_id, stripe_subscription_id, status, current_period_end,
                                   cancel_at_period_end, fs_id, arm, livemode, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(email) DO UPDATE SET
       stripe_customer_id = excluded.stripe_customer_id,
       stripe_subscription_id = excluded.stripe_subscription_id,
       status = excluded.status,
       current_period_end = excluded.current_period_end,
       cancel_at_period_end = excluded.cancel_at_period_end,
       fs_id = COALESCE(plus_subscribers.fs_id, excluded.fs_id),
       arm = COALESCE(plus_subscribers.arm, excluded.arm),
       livemode = excluded.livemode,
       updated_at = CURRENT_TIMESTAMP`
  ).bind(email, customerId, sub.id, sub.status, periodEndIso(sub), sub.cancel_at_period_end ? 1 : 0,
         fsId, arm, livemode ? 1 : 0).run();
}
// Shared by /plus/success and the checkout.session.completed webhook (either
// can arrive first; both are idempotent). Returns the member email or null.
async function recordCheckoutSession(env, session) {
  if (!session || session.mode !== "subscription" || session.status !== "complete") return null;
  const email = normEmail(session.customer_details?.email || session.customer_email);
  if (!email) return null;
  const sub = typeof session.subscription === "object" && session.subscription
    ? session.subscription
    : await stripe(env, "GET", `/subscriptions/${session.subscription}`);
  const meta = session.metadata || {};
  const fsId = /^[a-f0-9]{32}$/.test(session.client_reference_id || "") ? session.client_reference_id : null;
  const arm = ARMS.has(meta.arm) ? meta.arm : null;
  await upsertFromSubscription(env, { email, customerId: session.customer, sub, fsId, arm, livemode: session.livemode });
  if (fsId && arm && meta.preview !== "1") await logFunnel(env, fsId, arm, "purchased", null);
  return email;
}

// ── funnel log ──
async function logFunnel(env, fsId, arm, step, detail) {
  try {
    await env.DB.prepare(
      `INSERT INTO plus_funnel (fs_id, arm, step, detail) VALUES (?, ?, ?, ?)
       ON CONFLICT(fs_id, step) DO NOTHING`
    ).bind(fsId, arm, step, detail ? String(detail).slice(0, 80) : null).run();
  } catch (e) { console.warn("plus funnel write skipped:", e && e.message); }
}

// ── handlers ──
async function handleCheckout(request, env, url) {
  if (!env.STRIPE_PRICE_ID) return json({ error: "STRIPE_PRICE_ID is not set" }, 500);
  let body = {};
  try { body = await request.json(); } catch {}
  const fsId = firstSeenId(request);
  const arm = ARMS.has(body.arm) ? body.arm : null;
  const preview = body.preview ? "1" : "0";
  const back = `${url.origin}/?plus=cancelled${preview === "1" ? "&ff_plus=blur" : ""}`;
  const session = await stripe(env, "POST", "/checkout/sessions", {
    mode: "subscription",
    line_items: { 0: { price: env.STRIPE_PRICE_ID, quantity: 1 } },
    client_reference_id: fsId || undefined,
    metadata: { arm: arm || "", preview },
    subscription_data: { metadata: { arm: arm || "", preview, fs_id: fsId || "" } },
    allow_promotion_codes: "true",
    success_url: `${url.origin}/plus/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: back,
  });
  if (fsId && arm && preview !== "1") await logFunnel(env, fsId, arm, "checkout_start", null);
  return json({ url: session.url });
}

async function handleSuccess(request, env, url) {
  const id = url.searchParams.get("session_id") || "";
  if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return redirect("/?plus=pending");
  try {
    const session = await stripe(env, "GET", `/checkout/sessions/${id}`, { expand: { 0: "subscription" } });
    const email = await recordCheckoutSession(env, session);
    if (!email) return redirect("/?plus=pending");
    return redirect("/?plus=welcome", await memberCookies(env, email));
  } catch (e) {
    console.error("plus success failed", e);
    return redirect("/?plus=pending");
  }
}

// Stripe-Signature: t=<unix>,v1=<hex hmac of "t.body">; 5-minute tolerance.
async function verifyStripeSignature(env, request, raw) {
  const header = request.headers.get("Stripe-Signature") || "";
  const parts = Object.fromEntries(header.split(",").map(p => p.split("=")).filter(p => p.length === 2).map(([k, v]) => [k.trim(), v]));
  const sigs = header.split(",").filter(p => p.trim().startsWith("v1=")).map(p => p.trim().slice(3));
  const t = Number(parts.t);
  if (!env.STRIPE_WEBHOOK_SECRET || !t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - t) > 300) return false;
  const expected = await hmacHex(env.STRIPE_WEBHOOK_SECRET, `${t}.${raw}`);
  return sigs.some(s => safeEqual(s, expected));
}
async function handleWebhook(request, env) {
  const raw = await request.text();
  if (!(await verifyStripeSignature(env, request, raw))) return json({ error: "bad signature" }, 400);
  const evt = JSON.parse(raw);
  const obj = evt.data?.object || {};
  try {
    if (evt.type === "checkout.session.completed") {
      await recordCheckoutSession(env, obj);
    } else if (evt.type === "customer.subscription.updated" || evt.type === "customer.subscription.deleted") {
      await env.DB.prepare(
        `UPDATE plus_subscribers SET status = ?, current_period_end = ?, cancel_at_period_end = ?, updated_at = CURRENT_TIMESTAMP
          WHERE stripe_subscription_id = ?`
      ).bind(obj.status, periodEndIso(obj), obj.cancel_at_period_end ? 1 : 0, obj.id).run();
    } else if (evt.type === "charge.refunded" && obj.refunded && obj.customer) {
      // Full refund: lock right away (the subscription may still say active).
      await env.DB.prepare(
        `UPDATE plus_subscribers SET status = 'refunded', updated_at = CURRENT_TIMESTAMP WHERE stripe_customer_id = ?`
      ).bind(obj.customer).run();
    }
  } catch (e) {
    console.error("stripe webhook failed", evt.type, e);
    return json({ error: "handler failed" }, 500); // Stripe retries
  }
  return json({ received: true });
}

async function handleMe(request, env) {
  const email = await memberEmailFromCookie(request, env);
  if (!email) return json({ member: false }, 200, readCookie(request, PLUS_HINT_COOKIE) ? { "Set-Cookie": clearMemberCookies() } : {});
  const sub = await getSubscriber(env, email);
  const member = isActiveMember(sub);
  return json({
    member,
    status: sub?.status || null,
    renewsOn: sub?.current_period_end || null,
    cancelAtPeriodEnd: !!sub?.cancel_at_period_end,
    testMode: sub ? !sub.livemode : null,
  });
}

async function handleSignin(request, env, url) {
  let body = {};
  try { body = await request.json(); } catch {}
  const email = normEmail(body.email);
  // Same answer whether or not the address is a member, so this can't be used
  // to look up who subscribes.
  const done = json({ ok: true, message: "If that email has Playroute+, a sign-in link is on its way." });
  if (!email) return json({ ok: false, error: "Enter a valid email address." }, 400);
  const fsId = firstSeenId(request);
  if (fsId && ARMS.has(body.arm) && !body.preview) await logFunnel(env, fsId, body.arm, "signin_request", null);
  const sub = await getSubscriber(env, email);
  if (!isActiveMember(sub)) return done;
  // One link per 2 minutes per address (stops someone spamming a member).
  const recent = await env.DB.prepare(
    `SELECT 1 FROM plus_login_tokens WHERE email = ? AND created_at > datetime('now', '-2 minutes') LIMIT 1`
  ).bind(email).first();
  if (recent) return done;
  const token = randomToken(32);
  await env.DB.prepare(
    `INSERT INTO plus_login_tokens (token_hash, email, expires_at) VALUES (?, ?, datetime('now', ?))`
  ).bind(await sha256Hex(token), email, `+${LOGIN_TOKEN_MINUTES} minutes`).run();
  const link = `${url.origin}/plus/login?t=${token}`;
  if (!env.RESEND_API_KEY || !env.DIGEST_FROM) throw new Error("RESEND_API_KEY / DIGEST_FROM not configured");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.DIGEST_FROM,
      to: [email],
      subject: "Your Playroute+ sign-in link",
      text: `Tap to sign in to Playroute+ on this device:\n\n${link}\n\nThe link works once and expires in ${LOGIN_TOKEN_MINUTES} minutes. If you didn't ask for it, you can ignore this email.`,
      html: `<p>Tap to sign in to Playroute+ on this device:</p><p><a href="${link}" style="display:inline-block;padding:10px 18px;border-radius:100px;background:#5B84A0;color:#ffffff;text-decoration:none;font-weight:600;">Sign in to Playroute+</a></p><p style="color:#5B6560;font-size:13px;">The link works once and expires in ${LOGIN_TOKEN_MINUTES} minutes. If you didn't ask for it, you can ignore this email.</p>`,
    }),
  });
  if (!res.ok) console.error("plus sign-in email failed", res.status, await res.text());
  return done;
}

async function handleLogin(request, env, url) {
  const token = url.searchParams.get("t") || "";
  if (!/^[a-f0-9]{64}$/.test(token)) return redirect("/?plus=link-expired");
  const hash = await sha256Hex(token);
  // Single use: the UPDATE only matches an unused, unexpired token.
  const row = await env.DB.prepare(
    `UPDATE plus_login_tokens SET used_at = CURRENT_TIMESTAMP
      WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')
      RETURNING email`
  ).bind(hash).first();
  if (!row) return redirect("/?plus=link-expired");
  return redirect("/?plus=signed-in", await memberCookies(env, row.email));
}

async function handlePortal(request, env, url) {
  const email = await memberEmailFromCookie(request, env);
  const sub = email ? await getSubscriber(env, email) : null;
  if (!sub?.stripe_customer_id) return json({ error: "Not signed in to Playroute+." }, 401);
  const portal = await stripe(env, "POST", "/billing_portal/sessions", { customer: sub.stripe_customer_id, return_url: `${url.origin}/` });
  return json({ url: portal.url });
}

async function handleEvent(request, env) {
  let body = {};
  try { body = await request.json(); } catch {}
  const fsId = firstSeenId(request);
  if (!fsId || !ARMS.has(body.arm) || !FUNNEL_STEPS.has(body.step) || body.preview) return json({ ok: true, skipped: true });
  await logFunnel(env, fsId, body.arm, body.step, body.detail);
  return json({ ok: true });
}

// Admin > Tests: funnel per arm + return-visit guardrail + answers.
export async function handlePlusExperiment(env) {
  try {
    const [steps, guard, details, members] = await Promise.all([
      env.DB.prepare(`SELECT arm, step, COUNT(*) AS n FROM plus_funnel GROUP BY arm, step`).all(),
      env.DB.prepare(
        `SELECT f.arm, COUNT(*) AS n, SUM(v.visit_days >= 2) AS returned, AVG(v.visit_days) AS avg_days
           FROM plus_funnel f JOIN visitor_first_seen v ON v.fs_id = f.fs_id
          WHERE f.step = 'assigned' GROUP BY f.arm`
      ).all(),
      env.DB.prepare(
        `SELECT step, detail, COUNT(*) AS n FROM plus_funnel
          WHERE step IN ('not_now','why_subscribe') AND detail IS NOT NULL GROUP BY step, detail ORDER BY n DESC`
      ).all(),
      env.DB.prepare(
        `SELECT livemode, COUNT(*) AS n, SUM(status IN ('active','trialing','past_due')) AS active,
                SUM(cancel_at_period_end) AS cancelling
           FROM plus_subscribers GROUP BY livemode`
      ).all(),
    ]);
    const started = await env.DB.prepare(`SELECT MIN(first_at) AS t FROM plus_funnel WHERE step = 'assigned'`).first();
    const byArm = { plus: {}, control: {} };
    for (const r of steps.results || []) if (byArm[r.arm]) byArm[r.arm][r.step] = r.n;
    const guardrail = {};
    for (const r of guard.results || []) guardrail[r.arm] = { assigned: r.n, returned: r.returned || 0, avgDays: r.avg_days };
    return json({ byArm, guardrail, answers: details.results || [], members: members.results || [], startedAt: started?.t || null });
  } catch (e) {
    return json({ notReady: true, error: "Playroute+ tables are missing — run migrations/2026-11-17-plus-pilot.sql" });
  }
}

// Returns a Response for Playroute+ routes, or null so index.js keeps routing.
export async function handlePlusRoute(request, env, url) {
  const p = url.pathname, m = request.method;
  try {
    if (p === "/api/plus/checkout" && m === "POST") return await handleCheckout(request, env, url);
    if (p === "/plus/success" && m === "GET") return await handleSuccess(request, env, url);
    if (p === "/api/stripe-webhook" && m === "POST") return await handleWebhook(request, env);
    if (p === "/api/plus/me" && m === "GET") return await handleMe(request, env);
    if (p === "/api/plus/signin" && m === "POST") return await handleSignin(request, env, url);
    if (p === "/plus/login" && m === "GET") return await handleLogin(request, env, url);
    if (p === "/api/plus/portal" && m === "POST") return await handlePortal(request, env, url);
    if (p === "/api/plus/signout" && m === "POST") return json({ ok: true }, 200, { "Set-Cookie": clearMemberCookies() });
    if (p === "/api/plus/event" && m === "POST") return await handleEvent(request, env);
  } catch (e) {
    console.error("plus route failed", p, e);
    return json({ error: String(e && e.message ? e.message : e) }, 500);
  }
  return null;
}

// Exported for evals/plus-eval.js.
export const _test = { formEncode, periodEndIso, isActiveMember, normEmail, verifyStripeSignature, memberCookies, memberEmailFromCookie, hmacHex };
