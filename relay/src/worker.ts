// Relais Searchtide Connect (Cloudflare Worker + D1). Aucune donnée Stripe n'est stockée.
// Routes : /v1/health, /v1/start, /authorize, /oauth/authorize, /oauth/callback, /v1/token,
// /v1/stripe/read, /v1/revoke, /v1/webhook, /privacy, et les routes Google (voir google.ts).
import { D1Store, MemoryStore, sha256, type CodeRow, type StateRow, type Store, type TokenRow, type D1 } from "./store.ts";
import { PRIVACY_EN, PRIVACY_FR } from "./privacy.ts";
import { googleReady, handleGoogle } from "./google.ts";

export type Env = {
  DB?: D1;
  STRIPE_CLIENT_ID?: string;
  /** Clé restreinte en lecture (rk_) : lectures Stripe uniquement. */
  STRIPE_READ_KEY?: string;
  /** Clé de plateforme (sk_) : uniquement /oauth/token et /oauth/deauthorize. */
  STRIPE_OAUTH_KEY?: string;
  RATE_SECRET?: string;
  WEBHOOK_SECRET?: string;
  /** Ancien secret, accepté le temps d'une rotation Stripe. */
  WEBHOOK_SECRET_PREVIOUS?: string;
  STATE_SECRET?: string;
  /** Application Google (Agenda) : identifiant public et secret. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  MODE?: "test" | "live";
  RELAY_URL?: string;
  /** Tests uniquement. */
  __store?: Store;
  __fetch?: typeof fetch;
  __now?: () => number;
  __waitUntil?: (p: Promise<unknown>) => void;
};

const AUTHORIZE = "https://connect.stripe.com/oauth/authorize";
const TOKEN = "https://connect.stripe.com/oauth/token";
const DEAUTHORIZE = "https://connect.stripe.com/oauth/deauthorize";
const API = "https://api.stripe.com/v1";
const MAX_DAY = 500, MAX_MINUTE = 30;

const nowOf = (env: Env) => (env.__now ? env.__now() : Date.now());
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const random = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Signature Stripe (`Stripe-Signature`) : HMAC-SHA256 en hexadécimal. */
async function hmacHex(text: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text))));
}

async function hmac(text: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text))));
}
/** Comparaison à temps constant (les longueurs restent visibles). */
const same = (a: string, b: string) => {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
};
const signState = async (env: Env, nonce: string) => `${nonce}.${await hmac(nonce, env.STATE_SECRET!)}`;
async function verifyState(env: Env, raw: string) {
  if (!env.STATE_SECRET) return false;
  const [nonce, sig] = raw.split(".");
  if (!nonce || !sig) return false;
  return same(sig, await hmac(nonce, env.STATE_SECRET));
}
const pkce = async (verifier: string) => b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));

function storeOf(env: Env): Store {
  if (env.__store) return env.__store;
  if (!env.DB) throw new Error("D1 absent");
  return new D1Store(env.DB);
}
const fetchOf = (env: Env) => env.__fetch ?? fetch;

const SECRETS: (keyof Env)[] = ["STRIPE_CLIENT_ID", "STRIPE_READ_KEY", "STRIPE_OAUTH_KEY", "RATE_SECRET", "WEBHOOK_SECRET", "STATE_SECRET"];
const missingSecrets = (env: Env) => SECRETS.filter((k) => !env[k]);

/* ── lecture Stripe : liste blanche ───────────────────────────────────────── */
const OBJECTS: Record<string, { params: RegExp[]; trim: (o: any) => any }> = {
  balance: { params: [], trim: (o) => ({ available: o.available, pending: o.pending }) },
  balance_transactions: {
    params: [/^limit$/, /^starting_after$/, /^created\[(gte|gt|lte|lt)\]$/, /^type$/],
    trim: (o) => ({ data: (o.data ?? []).map((t: any) => ({ id: t.id, amount: t.amount, fee: t.fee, net: t.net, currency: t.currency, created: t.created, type: t.type })), has_more: !!o.has_more }),
  },
  subscriptions: {
    params: [/^limit$/, /^starting_after$/, /^status$/, /^created\[(gte|gt|lte|lt)\]$/, /^expand\[\]$/],
    trim: (o) => ({ data: (o.data ?? []).map((s: any) => ({
      id: s.id, status: s.status, created: s.created, currency: s.currency, cancel_at_period_end: !!s.cancel_at_period_end,
      items: { data: (s.items?.data ?? []).map((i: any) => ({ quantity: i.quantity, price: { unit_amount: i.price?.unit_amount, recurring: i.price?.recurring ? { interval: i.price.recurring.interval, interval_count: i.price.recurring.interval_count ?? 1 } : null } })) },
      discounts: (s.discounts ?? []).filter((d: any) => d && d.coupon).map((d: any) => ({ coupon: { percent_off: d.coupon.percent_off ?? null, amount_off: d.coupon.amount_off ?? null } })),
    })), has_more: !!o.has_more }),
  },
  customers: {
    params: [/^limit$/, /^starting_after$/, /^created\[(gte|gt|lte|lt)\]$/],
    trim: (o) => ({ data: (o.data ?? []).map((c: any) => ({ id: c.id, created: c.created, currency: c.currency })), has_more: !!o.has_more }),
  },
  account: { params: [], trim: (o) => ({ id: o.id, business_profile: o.business_profile ? { name: o.business_profile.name } : null, country: o.country, default_currency: o.default_currency, livemode: !!o.livemode }) },
};

/** Vrai si l'objet et tous ses paramètres passent la liste blanche (contrat CA62). */
export const relayAccepts = (object: string, params: Record<string, string>) => {
  const def = Object.hasOwn(OBJECTS, object) ? OBJECTS[object] : undefined;
  return !!def && Object.keys(params).every((k) => def.params.some((re) => re.test(k)));
};

/* ── pages HTML ───────────────────────────────────────────────────────────── */
const page = (title: string, body: string, status = 200) => new Response(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;color:#111}a{color:#0b6b5b}button{font:inherit;padding:.55rem 1rem;border-radius:999px;border:1px solid #bbb;background:#fff;cursor:pointer}.primary{background:#0b6b5b;color:#fff;border-color:#0b6b5b}code{background:#f3f4f6;padding:.1rem .3rem;border-radius:.3rem}</style></head><body>${body}</body></html>`,
  { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

/** CA59 : le préfixe des clés doit correspondre au mode (live ↔ rk_live_/sk_live_, test ↔ rk_test_/sk_test_). */
export function modeMismatch(env: Env) {
  const prefixes: Record<string, [string, string]> = { live: ["rk_live_", "sk_live_"], test: ["rk_test_", "sk_test_"] };
  const p = env.MODE ? prefixes[env.MODE] : undefined;
  const read = env.STRIPE_READ_KEY ?? "", oauth = env.STRIPE_OAUTH_KEY ?? "";
  if (!p || !read || !oauth) return false;
  return !(read.startsWith(p[0]) && oauth.startsWith(p[1]));
}

/** Vrai tant qu'un texte de politique attend une valeur (date de mise en ligne). */
export const policyIncomplete = (fr: string, en: string) => fr.includes("[À compléter") || en.includes("[À compléter");

function privacyPage() {
  return page("Searchtide Connect — confidentialité / privacy", `<h1>Searchtide Connect</h1><section lang="fr" style="white-space:pre-wrap">${esc(PRIVACY_FR)}</section><hr><section lang="en" style="white-space:pre-wrap">${esc(PRIVACY_EN)}</section>`);
}

/* ── handler ─────────────────────────────────────────────────────────────── */
export async function handle(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const store = storeOf(env);
  const now = nowOf(env);
  const route = `${req.method} ${url.pathname}`;
  const log = (status: number, instanceId: string | null = null) => { const p = store.log(route, status, instanceId, now); env.__waitUntil?.(p); return status; };
  const origin = (env.RELAY_URL ?? url.origin).replace(/\/$/, "");

  if (url.pathname === "/v1/health") {
    if (missingSecrets(env).length || (env.MODE !== "test" && env.MODE !== "live")) { log(503); return json({ ok: false, error: "Configuration incomplète" }, 503); }
    if (modeMismatch(env)) { log(503); return json({ ok: false, error: "Mode incohérent" }, 503); }
    log(200); return json({ ok: true, mode: env.MODE, ...(googleReady(env) ? { google: true } : {}) });
  }
  if (url.pathname === "/privacy") {
    if (env.MODE === "live" && policyIncomplete(PRIVACY_FR, PRIVACY_EN)) { log(503); return new Response("Politique incomplète : déploiement en production refusé.", { status: 503 }); }
    log(200); return privacyPage();
  }
  const g = await handleGoogle({ req, url, env, store, now, origin, fetch: fetchOf(env), log, json, page, esc, random, hmac, same, pkce,
    signState: (nonce) => signState(env, nonce), verifyState: (raw) => verifyState(env, raw) });
  if (g) return g;
  if (missingSecrets(env).length) { log(503); return json({ ok: false, error: "Configuration incomplète" }, 503); }
  if (modeMismatch(env) && ["/v1/start", "/oauth/authorize", "/oauth/callback"].includes(url.pathname)) { log(503); return json({ ok: false, error: "Mode incohérent" }, 503); }

  // Limitation de débit des routes non authentifiées (protège D1 et la clé de plateforme).
  const LIMITS: Record<string, number> = { "/v1/start": 20, "/authorize": 60, "/oauth/authorize": 60, "/oauth/callback": 60 };
  if (LIMITS[url.pathname]) {
    // CA58 : la clé de limitation est une empreinte HMAC non réversible, jamais l'adresse IP en clair.
    const ip = req.headers.get("cf-connecting-ip") ?? "inconnu";
    const ipHash = await hmac(ip, env.RATE_SECRET!);
    const hour = new Date(now).toISOString().slice(0, 13);
    if (!await store.rate(`${url.pathname}:${ipHash}`, hour, LIMITS[url.pathname])) { log(429); return json({ error: "Trop de demandes" }, 429, { "retry-after": "3600" }); }
  }

  if (url.pathname === "/v1/start") {
    if (req.method !== "POST") { log(405); return json({ error: "Méthode non autorisée" }, 405); }
    const b = await req.json().catch(() => ({})) as Record<string, string>;
    const instanceId = String(b.instance_id ?? ""), returnUrl = String(b.return_url ?? ""), challenge = String(b.code_challenge ?? "");
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(instanceId)) { log(400); return json({ error: "Instance invalide" }, 400); }
    let ret: URL; try { ret = new URL(returnUrl); } catch { log(400); return json({ error: "URL de retour invalide" }, 400); }
    const local = ["localhost", "127.0.0.1"].includes(ret.hostname);
    if (ret.protocol !== "https:" && !local) { log(400); return json({ error: "URL de retour en https requise" }, 400); }
    // C5/CA55 : l'hôte affiché est celui de return_url, jamais un nom fourni par l'instance.
    const host = ret.host;
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) { log(400); return json({ error: "PKCE invalide" }, 400); }
    const raw = await signState(env, random(16));
    await store.createState(await sha256(raw), { instanceId, host, challenge, returnUrl: ret.toString(), expiresAt: now + 10 * 60_000 });
    log(200, instanceId);
    return json({ authorize_url: `${origin}/authorize?state=${encodeURIComponent(raw)}` });
  }

  if (url.pathname === "/authorize" && req.method === "GET") {
    const raw = url.searchParams.get("state") ?? "";
    if (!await verifyState(env, raw)) { log(400); return page("Lien invalide", "<h1>Lien invalide</h1><p>Recommencez la connexion depuis votre instance.</p>", 400); }
    const st = await store.getState(await sha256(raw), now);
    if (!st) { log(410); return page("Demande expirée", "<h1>La demande a expiré</h1><p>Recommencez la connexion.</p>", 410); }
    log(200, st.instanceId);
    return page("Autoriser Searchtide Connect", `<h1>Autoriser Searchtide Connect ?</h1>
      <p>L'instance <strong>${esc(st.host)}</strong> demande à lire votre compte Stripe.</p>
      <p>Le service n'écrit rien sur votre compte et ne conserve aucune donnée Stripe. <a href="/privacy">Politique de confidentialité</a> · <a href="https://github.com/Nadir-DNA/searchtide">Code du relais</a>.</p>
      <p><a class="primary" style="display:inline-block;padding:.55rem 1rem;border-radius:999px;background:#0b6b5b;color:#fff;text-decoration:none" href="/oauth/authorize?state=${encodeURIComponent(raw)}">Autoriser</a>
      <a href="${esc(st.returnUrl)}${st.returnUrl.includes("?") ? "&" : "?"}error=access_denied" style="margin-left:1rem">Annuler</a></p>`);
  }

  if (url.pathname === "/oauth/authorize" && req.method === "GET") {
    const raw = url.searchParams.get("state") ?? "";
    if (!await verifyState(env, raw)) { log(400); return page("Lien invalide", "<h1>Lien invalide</h1>", 400); }
    const st = await store.getState(await sha256(raw), now);
    if (!st) { log(410); return page("Demande expirée", "<h1>La demande a expiré</h1><p>Recommencez la connexion.</p>", 410); }
    const target = new URL(AUTHORIZE);
    target.searchParams.set("response_type", "code");
    target.searchParams.set("client_id", env.STRIPE_CLIENT_ID!);
    target.searchParams.set("scope", "read_write");
    target.searchParams.set("redirect_uri", `${origin}/oauth/callback`);
    target.searchParams.set("state", raw);
    log(302, st.instanceId);
    return Response.redirect(target.toString(), 302);
  }

  if (url.pathname === "/oauth/callback" && req.method === "GET") {
    const raw = url.searchParams.get("state") ?? "";
    if (!await verifyState(env, raw)) { log(400); return page("Lien invalide", "<h1>Lien invalide</h1>", 400); }
    const st = await store.takeState(await sha256(raw), now);
    if (!st) { log(410); return page("Demande expirée", "<h1>La demande a expiré</h1><p>Recommencez la connexion depuis votre instance.</p>", 410); }
    const back = (q: string) => `${st.returnUrl}${st.returnUrl.includes("?") ? "&" : "?"}${q}`;
    if (url.searchParams.get("error")) { log(400, st.instanceId); return Response.redirect(back("error=access_denied"), 302); }
    const code = url.searchParams.get("code") ?? "";
    if (!code) { log(400, st.instanceId); return Response.redirect(back("error=invalid_request"), 302); }
    const basic = btoa(`${env.STRIPE_OAUTH_KEY}:`);
    const tr = await fetchOf(env)(TOKEN, { method: "POST", headers: { Authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code }) });
    const tok = await tr.json().catch(() => ({})) as any;
    if (!tr.ok || !tok.stripe_user_id) { log(502, st.instanceId); return page("Stripe a refusé", "<h1>Stripe n'a pas accepté la connexion</h1><p>Recommencez depuis votre instance.</p>"); }
    if (env.MODE === "test" && tok.livemode) { log(403, st.instanceId); return page("Compte de test requis", "<h1>Ce service n'accepte que des comptes de test pour le moment.</h1>"); }
    const existing = await store.findByStripeUser(String(tok.stripe_user_id));
    if (existing && existing.instanceId !== st.instanceId) { log(409, st.instanceId); return page("Compte déjà relié", `<h1>Ce compte Stripe est déjà relié à l'instance ${esc(existing.host)}.</h1><p>Révoquez-la d'abord, ou utilisez une clé limitée. Vous pouvez aussi retirer l'application dans votre <a href="https://dashboard.stripe.com/settings/apps">Dashboard Stripe</a>.</p>`, 409); }
    const instCode = random(24);
    await store.createCode(await sha256(instCode), { ...st, stripeUserId: String(tok.stripe_user_id), livemode: !!tok.livemode, expiresAt: now + 60_000 });
    log(200, st.instanceId);
    // L'instance retrouve son vérificateur PKCE par le state signé : il doit revenir avec le code.
    return Response.redirect(back(`code=${encodeURIComponent(instCode)}&state=${encodeURIComponent(raw)}`), 302);
  }

  if (url.pathname === "/v1/token") {
    if (req.method !== "POST") { log(405); return json({ error: "Méthode non autorisée" }, 405); }
    const b = await req.json().catch(() => ({})) as Record<string, string>;
    const code = String(b.code ?? ""), verifier = String(b.code_verifier ?? ""), instanceId = String(b.instance_id ?? "");
    if (!code || !verifier || !instanceId) { log(400); return json({ error: "Requête incomplète" }, 400); }
    const codeHash = await sha256(code);
    const c = await store.getCode(codeHash, now);
    if (!c || c.instanceId !== instanceId || !same(await pkce(verifier), c.challenge)) { log(400, instanceId); return json({ error: "Code invalide" }, 400); }
    if (!await store.useCode(codeHash, now)) { log(400, instanceId); return json({ error: "Code déjà utilisé" }, 400); }
    const token = `relay_${random(32)}`;
    const row: TokenRow = { instanceId, host: c.host, stripeUserId: c.stripeUserId, livemode: c.livemode, createdAt: now, lastUsed: now, day: "", dayCount: 0, minute: "", minuteCount: 0 };
    await store.createToken(await sha256(token), row);
    log(200, instanceId);
    return json({ token, hint: `relay_…${token.slice(-4)}`, stripe_user_id: c.stripeUserId, livemode: c.livemode, mode: env.MODE });
  }

  if (url.pathname === "/v1/stripe/read") {
    if (req.method !== "POST") { log(405); return json({ error: "Méthode non autorisée" }, 405); }
    const token = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    const t = token ? await store.findToken(await sha256(token)) : null;
    if (!t) { log(401); return json({ error: "Jeton inconnu" }, 401); }
    const day = new Date(now).toISOString().slice(0, 10), minute = new Date(now).toISOString().slice(0, 16);
    const q = await store.quota(await sha256(token), now, day, minute, MAX_DAY, MAX_MINUTE);
    if (q !== "ok") { log(429, t.instanceId); return json({ error: "quota" }, 429, { "retry-after": q === "day" ? "3600" : "60" }); }
    const b = await req.json().catch(() => ({})) as { object?: string; params?: Record<string, string> };
    const def = b.object && Object.hasOwn(OBJECTS, b.object) ? OBJECTS[b.object] : undefined;
    if (!def) { log(400, t.instanceId); return json({ error: "Objet non autorisé" }, 403); }
    const params = b.params ?? {};
    for (const k of Object.keys(params)) {
      if (!def.params.some((re) => re.test(k))) { log(400, t.instanceId); return json({ error: `Paramètre refusé : ${k}` }, 400); }
      if (k === "expand[]" && String(params[k]) !== "data.discounts") { log(400, t.instanceId); return json({ error: "Seul data.discounts peut être étendu" }, 400); }
    }
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
    const r = await fetchOf(env)(`${API}/${b.object}${qs ? `?${qs}` : ""}`, { method: "GET", headers: { Authorization: `Bearer ${env.STRIPE_READ_KEY}`, "Stripe-Account": t.stripeUserId } });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { log(502, t.instanceId); return json({ error: r.status === 401 ? "stripe_auth" : "stripe_error" }, 502); }
    log(200, t.instanceId);
    return json(def.trim(data), 200, { "cache-control": "no-store" });
  }

  if (url.pathname === "/v1/revoke") {
    if (req.method !== "POST") { log(405); return json({ error: "Méthode non autorisée" }, 405); }
    const token = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    const hash = await sha256(token); const t = token ? await store.findToken(hash) : null;
    if (!t) { log(401); return json({ error: "Jeton inconnu" }, 401); }
    let refused = false;
    try {
      const basic = btoa(`${env.STRIPE_OAUTH_KEY}:`);
      const r = await fetchOf(env)(DEAUTHORIZE, { method: "POST", headers: { Authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: env.STRIPE_CLIENT_ID!, stripe_user_id: t.stripeUserId }) });
      if (!r.ok) {
        // Application déjà retirée (Dashboard Stripe) : la révocation est idempotente, ce n'est pas un échec.
        const j = await r.json().catch(() => ({})) as any;
        const detail = String(j.error_description ?? j.error ?? "");
        refused = !/not (connected|authorized)|no longer|already|deauthori[sz]ed|revoked/i.test(detail);
      }
    } catch { refused = true; }
    // Le jeton local disparaît dans tous les cas ; l'instance prévient si Stripe a refusé.
    await store.deleteToken(hash);
    if (refused) { log(502, t.instanceId); return json({ ok: false, error: "Stripe a refusé la désautorisation. Retirez l'application dans votre Dashboard Stripe." }, 502); }
    log(200, t.instanceId);
    return json({ ok: true });
  }

  if (url.pathname === "/v1/webhook") {
    if (req.method !== "POST") { log(405); return json({ error: "Méthode non autorisée" }, 405); }
    const raw = await req.text();
    const sig = req.headers.get("stripe-signature") ?? "";
    const chunks = sig.split(",").map((p) => p.trim()).filter(Boolean);
    const t = chunks.find((p) => p.startsWith("t="))?.slice(2) ?? "";
    const v1s = chunks.filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
    if (!t || !v1s.length) { log(400); return json({ error: "Signature absente" }, 400); }
    // Pendant une rotation, Stripe envoie plusieurs v1 (ancien et nouveau secret).
    const expected = await hmacHex(`${t}.${raw}`, env.WEBHOOK_SECRET!);
    const previous = env.WEBHOOK_SECRET_PREVIOUS ? await hmacHex(`${t}.${raw}`, env.WEBHOOK_SECRET_PREVIOUS) : null;
    if (!v1s.some((v) => same(v, expected) || (!!previous && same(v, previous)))) { log(400); return json({ error: "Signature invalide" }, 400); }
    if (!/^\d+$/.test(t) || Math.abs(now / 1000 - Number(t)) > 300) { log(400); return json({ error: "Signature expirée" }, 400); }
    const event = JSON.parse(raw || "{}");
    if (event.type === "account.application.deauthorized" && event.account) { await store.deleteByStripeUser(String(event.account)); log(200); return json({ received: true }); }
    log(200); return json({ received: true });
  }

  log(404);
  return json({ error: "Route inconnue" }, 404);
}

export default {
  fetch: (req: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) => handle(req, { ...env, __waitUntil: (p) => ctx.waitUntil(p) }),
  scheduled: async (_event: unknown, env: Env) => { await storeOf(env).purge(nowOf(env)); },
};
