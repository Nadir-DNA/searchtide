// CA26 à CA33, CA46 à CA53 : relais Searchtide Connect, Stripe et D1 simulés (aucun appel réseau).
import { test } from "node:test";
import assert from "node:assert/strict";
import { handle, policyIncomplete, type Env } from "./src/worker.ts";
import { PRIVACY_FR, PRIVACY_EN } from "./src/privacy.ts";
import { MemoryStore, sha256 } from "./src/store.ts";

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = (s: string) => new TextEncoder().encode(s);
const verifier = "v".repeat(43);
const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc(verifier))));
let clock = Date.parse("2026-11-10T10:00:00Z");
const now = () => clock;

type Call = { url: string; init: RequestInit };
function fakeFetch(calls: Call[]) {
  return (async (u: any, i: RequestInit = {}) => {
    const url = String(u); calls.push({ url, init: i });
    if (url.startsWith("https://connect.stripe.com/oauth/token")) return Response.json({ stripe_user_id: "acct_TEST", livemode: false, scope: "read_write" });
    if (url.startsWith("https://connect.stripe.com/oauth/deauthorize")) return Response.json({ stripe_user_id: "acct_TEST" });
    if (url.includes("/customers")) return Response.json({ data: [{ id: "cus_1", created: 1, currency: "eur", email: "secret@exemple.com", name: "Nom", address: "rue" }], has_more: false });
    if (url.includes("/balance")) return Response.json({ available: [{ amount: 100, currency: "eur" }], pending: [] });
    if (url.includes("/account")) return Response.json({ id: "acct_TEST", business_profile: { name: "Boutique" }, country: "FR", default_currency: "eur", livemode: false });
    return Response.json({ data: [], has_more: false });
  }) as typeof fetch;
}
function setup(over: Partial<Env> = {}) {
  const store = new MemoryStore(); const calls: Call[] = [];
  const env: Env = {
    STRIPE_CLIENT_ID: "ca_TEST", STRIPE_READ_KEY: "rk_test_read-key-fake", STRIPE_OAUTH_KEY: "sk_test_oauth-key-fake", RATE_SECRET: "rate-secret-0123456789", WEBHOOK_SECRET: "webhook-secret-fake", STATE_SECRET: "state-secret-0123456789",
    MODE: "test", RELAY_URL: "https://connect.test", __store: store, __fetch: fakeFetch(calls), __now: now, ...over,
  };
  return { store, calls, env };
}
const post = (path: string, body: unknown, env: Env, headers: Record<string, string> = {}) =>
  handle(new Request(`https://connect.test${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), env);
const get = (path: string, env: Env) => handle(new Request(`https://connect.test${path}`), env);

async function flow(env: Env, host = "instance.test", headers: Record<string, string> = {}) {
  const s = await (await post("/v1/start", { instance_id: "inst-1234", instance_host: host, return_url: "https://instance.test/oauth/callback", code_challenge: challenge }, env, headers)).json() as any;
  const state = new URL(s.authorize_url).searchParams.get("state")!;
  const cb = await get(`/oauth/callback?code=ac_1&state=${encodeURIComponent(state)}`, env);
  assert.equal(cb.status, 302);
  const code = new URL(cb.headers.get("location")!).searchParams.get("code")!;
  const t = await (await post("/v1/token", { code, code_verifier: verifier, instance_id: "inst-1234" }, env)).json() as any;
  return { state, code, token: t.token as string, hint: t.hint as string, s };
}

test("CA53/health : 503 si un secret manque, 200 avec le mode", async () => {
  const { env } = setup({ STRIPE_READ_KEY: undefined });
  assert.equal((await get("/v1/health", env)).status, 503);
  const ok = await get("/v1/health", setup().env);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, mode: "test" });
});

test("CA29 : URL de retour https exigée (localhost toléré), page intermédiaire avec l'hôte", async () => {
  const { env } = setup();
  const bad = await post("/v1/start", { instance_id: "inst-1234", instance_host: "x.test", return_url: "http://x.test/cb", code_challenge: challenge }, env);
  assert.equal(bad.status, 400);
  const local = await post("/v1/start", { instance_id: "inst-1234", instance_host: "x.test", return_url: "http://localhost:3030/cb", code_challenge: challenge }, env);
  assert.equal(local.status, 200);
  const s = await (await post("/v1/start", { instance_id: "inst-1234", instance_host: "instance.test", return_url: "https://instance.test/cb", code_challenge: challenge }, env)).json() as any;
  const page = await get(`/authorize?state=${encodeURIComponent(new URL(s.authorize_url).searchParams.get("state")!)}`, env);
  assert.match(await page.text(), /instance\.test/);
});

test("CA28/CA47 : state rejoué refusé, mauvais vérificateur refusé, code à usage unique", async () => {
  const { env } = setup();
  const f = await flow(env);
  const replay = await get(`/oauth/callback?code=ac_2&state=${encodeURIComponent(f.state)}`, env);
  assert.equal(replay.status, 410);
  const s = await (await post("/v1/start", { instance_id: "inst-1234", instance_host: "i.test", return_url: "https://i.test/cb", code_challenge: challenge }, env)).json() as any;
  const state = new URL(s.authorize_url).searchParams.get("state")!;
  const cb = await get(`/oauth/callback?code=ac_3&state=${encodeURIComponent(state)}`, env);
  const code = new URL(cb.headers.get("location")!).searchParams.get("code")!;
  const wrong = await post("/v1/token", { code, code_verifier: "w".repeat(43), instance_id: "inst-1234" }, env);
  assert.equal(wrong.status, 400);
  const ok = await post("/v1/token", { code, code_verifier: verifier, instance_id: "inst-1234" }, env);
  assert.equal(ok.status, 200);
});

test("CA28 : un code d'instance expire après 60 s", async () => {
  const { env } = setup();
  const s = await (await post("/v1/start", { instance_id: "inst-1234", instance_host: "i.test", return_url: "https://i.test/cb", code_challenge: challenge }, env)).json() as any;
  const state = new URL(s.authorize_url).searchParams.get("state")!;
  const cb = await get(`/oauth/callback?code=ac_4&state=${encodeURIComponent(state)}`, env);
  const code = new URL(cb.headers.get("location")!).searchParams.get("code")!;
  clock += 61_000;
  const late = await post("/v1/token", { code, code_verifier: verifier, instance_id: "inst-1234" }, env);
  assert.equal(late.status, 400);
  clock = Date.parse("2026-11-10T10:00:00Z");
});

test("CA26/27/46 : lecture en liste blanche, customers réduits, no-store, GET refusé", async () => {
  const { env, calls } = setup();
  const f = await flow(env);
  const auth = { authorization: `Bearer ${f.token}` };
  const getRead = await handle(new Request("https://connect.test/v1/stripe/read", { headers: auth }), env);
  assert.equal(getRead.status, 405);
  assert.equal((await post("/v1/stripe/read", { object: "charges" }, env, auth)).status, 403);
  assert.equal((await post("/v1/stripe/read", { object: "customers", params: { email: "x" } }, env, auth)).status, 400);
  const r = await post("/v1/stripe/read", { object: "customers", params: { limit: "10" } }, env, auth);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const body = await r.json() as any;
  assert.deepEqual(body.data[0], { id: "cus_1", created: 1, currency: "eur" });
  assert.doesNotMatch(JSON.stringify(body), /secret@exemple|Nom|rue/);
  const api = calls.find((c) => c.url.includes("/customers"))!;
  assert.equal((api.init.headers as Record<string, string>)["Stripe-Account"], "acct_TEST");
});

test("CA31/CA46 : base sans donnée Stripe et journaux sans secret ni paramètre", async () => {
  const { env, store } = setup();
  const f = await flow(env);
  const auth = { authorization: `Bearer ${f.token}` };
  await post("/v1/stripe/read", { object: "customers", params: { limit: "1" } }, env, auth);
  const dump = JSON.stringify({ tokens: [...store.tokens], states: [...store.states], codes: [...store.codes], logs: store.logs });
  assert.doesNotMatch(dump, /cus_1|secret@exemple|sk_test_FAKE|whsec_|state-secret/);
  for (const l of store.logs) assert.deepEqual(Object.keys(l).sort(), ["at", "instanceId", "route", "status"]);
});

test("CA49 : quota de 500 lectures par jour et 30 par minute, indépendant par jeton", async () => {
  const { env, store } = setup();
  const f = await flow(env);
  const hash = await sha256(f.token);
  const t = store.tokens.get(hash)!;
  t.day = new Date(clock).toISOString().slice(0, 10); t.dayCount = 500;
  const auth = { authorization: `Bearer ${f.token}` };
  const r = await post("/v1/stripe/read", { object: "balance" }, env, auth);
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get("retry-after")) > 0);
  const other = await flow(env, "autre.test");
  assert.equal((await post("/v1/stripe/read", { object: "balance" }, env, { authorization: `Bearer ${other.token}` })).status, 200);
});

test("CA30 : webhook signé invalide les jetons, signature fausse refusée ; révocation supprime le jeton", async () => {
  const { env, store, calls } = setup();
  const f = await flow(env);
  const raw = JSON.stringify({ type: "account.application.deauthorized", account: "acct_TEST" });
  assert.equal((await post("/v1/webhook", JSON.parse(raw), env, { "stripe-signature": "t=1,v1=faux" })).status, 400);
  const t = String(Math.floor(clock / 1000));
  const key = await crypto.subtle.importKey("raw", enc("webhook-secret-fake"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, enc(`${t}.${raw}`)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const wh = await handle(new Request("https://connect.test/v1/webhook", { method: "POST", headers: { "stripe-signature": `t=${t},v1=${sig}` }, body: raw }), env);
  assert.equal(wh.status, 200);
  assert.equal((await post("/v1/stripe/read", { object: "balance" }, env, { authorization: `Bearer ${f.token}` })).status, 401);
  const g = await flow(env, "rev.test");
  assert.equal((await post("/v1/revoke", {}, env, { authorization: `Bearer ${g.token}` })).status, 200);
  assert.equal((await post("/v1/stripe/read", { object: "balance" }, env, { authorization: `Bearer ${g.token}` })).status, 401);
  assert.ok(calls.some((c) => c.url.includes("deauthorize")));
});

test("CA48 : purge des états, codes, journaux de 7 jours et jetons inactifs de 180 jours", async () => {
  const { env, store } = setup();
  const f = await flow(env);
  const oldState = await (await post("/v1/start", { instance_id: "vieux-1234", instance_host: "v.test", return_url: "https://v.test/cb", code_challenge: challenge }, env)).json() as any;
  const oldRaw = new URL(oldState.authorize_url).searchParams.get("state")!;
  store.states.get(await sha256(oldRaw))!.expiresAt = clock - 1000;
  store.logs.push({ route: "GET /x", status: 200, instanceId: null, at: clock - 8 * 86400_000 });
  const old = await sha256(f.token);
  store.tokens.get(old)!.lastUsed = clock - 181 * 86400_000;
  await (env as any).__store.purge(clock);
  assert.equal(store.states.size, 0);
  assert.equal(store.codes.size, 0);
  assert.equal(store.logs.filter((l) => l.at < clock - 7 * 86400_000).length, 0);
  assert.equal(store.tokens.has(old), false);
});

test("CA50/CA52 : politique FR/EN datée, garde du placeholder ; mode test refuse un compte live", async () => {
  const { env } = setup();
  const p = await get("/privacy", env);
  assert.equal(p.status, 200);
  const html = await p.text();
  assert.match(html, /Français|Searchtide Connect/);
  assert.match(html, /France/);
  assert.match(html, /github\.com\/Nadir-DNA\/searchtide\/tree\/main\/relay/);
  assert.equal((await get("/privacy", { ...env, MODE: "live" })).status, 200, "date remplie : le mode live sert la politique");
  assert.equal(policyIncomplete("Dernière mise à jour : [À compléter", ""), true);
  assert.equal(policyIncomplete(PRIVACY_FR, PRIVACY_EN), false);
  const calls: Call[] = [];
  const liveEnv = setup({ __fetch: (async (u: any, i: RequestInit = {}) => {
    calls.push({ url: String(u), init: i });
    if (String(u).includes("oauth/token")) return Response.json({ stripe_user_id: "acct_LIVE", livemode: true });
    return Response.json({});
  }) as typeof fetch }).env;
  const s = await (await post("/v1/start", { instance_id: "inst-1234", instance_host: "i.test", return_url: "https://i.test/cb", code_challenge: challenge }, liveEnv)).json() as any;
  const state = new URL(s.authorize_url).searchParams.get("state")!;
  const cb = await get(`/oauth/callback?code=ac_9&state=${encodeURIComponent(state)}`, liveEnv);
  assert.equal(cb.status, 200);
  assert.match(await cb.text(), /comptes de test/);
});

test("CA55 : la page intermédiaire affiche l'hôte de return_url, pas le nom annoncé par l'instance", async () => {
  const { env } = setup();
  const s = await (await post("/v1/start", { instance_id: "inst-1234", instance_host: "faux.test", return_url: "https://reel.test/cb", code_challenge: challenge }, env)).json() as any;
  const page = await get(`/authorize?state=${encodeURIComponent(new URL(s.authorize_url).searchParams.get("state")!)}`, env);
  const html = await page.text();
  assert.match(html, /reel\.test/); assert.doesNotMatch(html, /faux\.test/);
});

test("CA56 : constructor, __proto__ et toString sont refusés par la liste blanche", async () => {
  const { env } = setup(); const f = await flow(env); const auth = { authorization: `Bearer ${f.token}` };
  for (const object of ["constructor", "__proto__", "toString"]) {
    assert.equal((await post("/v1/stripe/read", { object }, env, auth)).status, 403, object);
  }
});

test("CA54 : le relais conserve interval_count et les remises des abonnements", async () => {
  const seen: string[] = [];
  const { env } = setup({ __fetch: (async (u: any) => {
    const url = String(u); seen.push(url);
    if (url.includes("oauth/token")) return Response.json({ stripe_user_id: "acct_TEST", livemode: false });
    if (url.includes("/subscriptions")) return Response.json({ data: [{ id: "sub_1", status: "active", created: 1, currency: "eur", cancel_at_period_end: false, items: { data: [{ quantity: 1, price: { unit_amount: 3000, recurring: { interval: "month", interval_count: 3 } } }] }, discounts: [{ coupon: { percent_off: 50, amount_off: null } }] }], has_more: false });
    return Response.json({});
  }) as typeof fetch });
  const f = await flow(env);
  const r = await (await post("/v1/stripe/read", { object: "subscriptions", params: { "expand[]": "data.discounts" } }, env, { authorization: `Bearer ${f.token}` })).json() as any;
  assert.equal(r.data[0].items.data[0].price.recurring.interval_count, 3);
  assert.deepEqual(r.data[0].discounts[0].coupon, { percent_off: 50, amount_off: null });
  assert.ok(seen.some((u) => u.includes("/subscriptions") && /expand[^=]*=data\.discounts/.test(u)));
});

test("N-4 : lecture avec STRIPE_READ_KEY, token/déauthorisation avec STRIPE_OAUTH_KEY uniquement", async () => {
  const { env, calls } = setup(); const f = await flow(env);
  await post("/v1/stripe/read", { object: "balance" }, env, { authorization: `Bearer ${f.token}` });
  const api = calls.find((c) => c.url.includes("/v1/balance"))!;
  assert.match(String((api.init.headers as any).Authorization), /read-key-fake/);
  const token = calls.find((c) => c.url.includes("oauth/token"))!;
  assert.match(String((token.init.headers as any).Authorization), new RegExp(btoa("sk_test_oauth-key-fake:")));
});

test("Limitation de débit : /v1/start plafonne à 20 par heure et par IP", async () => {
  const { env } = setup();
  for (let i = 0; i < 20; i++) assert.equal((await post("/v1/start", { instance_id: "inst-1234", return_url: "https://i.test/cb", code_challenge: challenge }, env)).status, 200, String(i));
  const blocked = await post("/v1/start", { instance_id: "inst-1234", return_url: "https://i.test/cb", code_challenge: challenge }, env);
  assert.equal(blocked.status, 429);
});

test("Webhook : une signature valide mais trop ancienne est refusée", async () => {
  const { env } = setup(); const raw = JSON.stringify({ type: "x" });
  const t = String(Math.floor(clock / 1000) - 301);
  const key = await crypto.subtle.importKey("raw", enc("webhook-secret-fake"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, enc(`${t}.${raw}`)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  assert.equal((await handle(new Request("https://connect.test/v1/webhook", { method: "POST", headers: { "stripe-signature": `t=${t},v1=${sig}` }, body: raw }), env)).status, 400);
});

test("CA58 : la limitation stocke une empreinte HMAC, pas l'adresse IP, et la purge efface après une heure", async () => {
  const { env, store } = setup();
  const ip = "203.0.113.9";
  await post("/v1/start", { instance_id: "inst-1234", return_url: "https://i.test/cb", code_challenge: challenge }, env, { "cf-connecting-ip": ip });
  const keys = [...store.rates.keys()];
  assert.equal(keys.length, 1);
  assert.ok(!keys[0].includes(ip), "l'IP ne doit pas être stockée");
  assert.match(keys[0], /^\/v1\/start:[A-Za-z0-9_-]{43}$/);
  store.rates.set(keys[0], { window: "2000-01-01T00", count: 1 });
  await store.purge(clock);
  assert.equal(store.rates.size, 0);
});

test("Le retour OAuth renvoie le code ET le state, pour que l'instance retrouve son vérificateur PKCE", async () => {
  const { env } = setup();
  const s = await (await post("/v1/start", { instance_id: "inst-1234", return_url: "https://i.test/cb", code_challenge: challenge }, env)).json() as any;
  const state = new URL(s.authorize_url).searchParams.get("state")!;
  const cb = await handle(new Request(`https://connect.test/oauth/callback?state=${encodeURIComponent(state)}&code=ac_TEST`, { method: "GET" }), env);
  assert.equal(cb.status, 302);
  const loc = new URL(cb.headers.get("location")!);
  assert.match(loc.searchParams.get("code")!, /^[A-Za-z0-9_-]{24,}$/);
  assert.equal(loc.searchParams.get("state"), state);
});

async function hexSig(secret: string, t: string, raw: string) {
  const key = await crypto.subtle.importKey("raw", enc(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, enc(`${t}.${raw}`)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

test("T43a : plusieurs v1 pendant une rotation sont acceptés, un faux v1 est refusé", async () => {
  const { env } = setup({ WEBHOOK_SECRET_PREVIOUS: "ancien-secret-0123456789" });
  const raw = JSON.stringify({ type: "account.application.deauthorized", account: "acct_TEST" });
  const t = String(Math.floor(clock / 1000));
  const bon = await hexSig("webhook-secret-fake", t, raw);
  const ancien = await hexSig("ancien-secret-0123456789", t, raw);
  const req = (header: string) => handle(new Request("https://connect.test/v1/webhook", { method: "POST", headers: { "stripe-signature": header }, body: raw }), env);
  assert.equal((await req(`t=${t},v1=${ancien},v1=${bon}`)).status, 200, "ancien puis nouveau");
  assert.equal((await req(`t=${t},v1=faux,v1=${bon}`)).status, 200, "faux puis valide");
  assert.equal((await req(`t=${t},v1=${"0".repeat(64)}`)).status, 400, "faux seul");
});

test("T43b : /v1/revoke renvoie une erreur explicite quand Stripe refuse, et supprime quand même le jeton", async () => {
  const { env } = setup({ __fetch: (async (u: any) => {
    if (String(u).includes("oauth/token")) return Response.json({ stripe_user_id: "acct_TEST", livemode: false });
    if (String(u).includes("deauthorize")) return new Response("{}", { status: 403 });
    return Response.json({});
  }) as typeof fetch });
  const f = await flow(env, "refus.test", { "cf-connecting-ip": "198.51.100.7" });
  const r = await post("/v1/revoke", {}, env, { authorization: `Bearer ${f.token}`, "cf-connecting-ip": "198.51.100.7" });
  assert.equal(r.status, 502);
  const body = await r.json() as any;
  assert.equal(body.ok, false);
  assert.match(body.error, /Dashboard Stripe/);
  assert.equal((await post("/v1/stripe/read", { object: "balance" }, env, { authorization: `Bearer ${f.token}` })).status, 401);
});

test("Liste blanche : created[gte]/[lt] acceptés pour le CA net, created[foo] refusé", async () => {
  const { env } = setup();
  const f = await flow(env, "dates.test", { "cf-connecting-ip": "198.51.100.8" });
  const h = { authorization: `Bearer ${f.token}`, "cf-connecting-ip": "198.51.100.8" };
  assert.equal((await post("/v1/stripe/read", { object: "balance_transactions", params: { "created[gte]": "1", "created[lt]": "2" } }, env, h)).status, 200);
  assert.equal((await post("/v1/stripe/read", { object: "balance_transactions", params: { "created[foo]": "1" } }, env, h)).status, 400);
});

test("T43b : une application déjà retirée côté Stripe est un succès idempotent", async () => {
  const { env } = setup({ __fetch: (async (u: any) => {
    if (String(u).includes("oauth/token")) return Response.json({ stripe_user_id: "acct_TEST", livemode: false });
    if (String(u).includes("deauthorize")) return new Response(JSON.stringify({ error: "invalid_request", error_description: "This account is not connected to your application." }), { status: 400, headers: { "content-type": "application/json" } });
    return Response.json({});
  }) as typeof fetch });
  const f = await flow(env, "deja.test", { "cf-connecting-ip": "198.51.100.9" });
  const r = await post("/v1/revoke", {}, env, { authorization: `Bearer ${f.token}`, "cf-connecting-ip": "198.51.100.9" });
  assert.equal(r.status, 200);
  assert.equal((await r.json() as any).ok, true);
  assert.equal((await post("/v1/stripe/read", { object: "balance" }, env, { authorization: `Bearer ${f.token}` })).status, 401);
});

test("CA59 : clés et mode incohérents → 503 sur santé, start et OAuth", async () => {
  const liveAvecClesTest = setup({ MODE: "live" });
  assert.equal((await get("/v1/health", liveAvecClesTest.env)).status, 503);
  const start = { instance_id: "inst-1234", return_url: "https://i.test/cb", code_challenge: challenge };
  assert.equal((await post("/v1/start", start, liveAvecClesTest.env)).status, 503);
  assert.equal((await get("/oauth/authorize?state=x", liveAvecClesTest.env)).status, 503);
  assert.equal((await get("/oauth/callback?state=x&code=y", liveAvecClesTest.env)).status, 503);

  const testAvecClesLive = setup({ STRIPE_READ_KEY: "rk_live_x", STRIPE_OAUTH_KEY: "sk_live_x" });
  assert.equal((await get("/v1/health", testAvecClesLive.env)).status, 503);
  assert.equal((await post("/v1/start", start, testAvecClesLive.env)).status, 503);

  const coherent = setup({ MODE: "live", STRIPE_READ_KEY: "rk_live_x", STRIPE_OAUTH_KEY: "sk_live_x" });
  const h = await get("/v1/health", coherent.env);
  assert.equal(h.status, 200);
  assert.deepEqual(await h.json(), { ok: true, mode: "live" });
  assert.equal((await post("/v1/start", start, coherent.env)).status, 200);
});
