// Relais, volet Google Agenda : Google simulé (aucun appel réseau), D1 simulé.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handle, type Env } from "./src/worker.ts";
import { MemoryStore } from "./src/store.ts";

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const verifier = "v".repeat(43);
const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
const SCOPES = "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy";
const REFRESH = "1//0g-refresh-token-FIXTURE-0123456789";

function setup(over: Partial<Env> = {}, granted = SCOPES) {
  const store = new MemoryStore(); const calls: { url: string; body: string }[] = [];
  const __fetch = (async (u: any, i: RequestInit = {}) => {
    const url = String(u), body = String(i.body ?? ""); calls.push({ url, body });
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      if (body.includes("grant_type=refresh_token")) return body.includes("revoked") ? Response.json({ error: "invalid_grant" }, { status: 400 }) : Response.json({ access_token: "ya29.FIXTURE", expires_in: 3599 });
      return Response.json({ access_token: "ya29.first", refresh_token: REFRESH, scope: granted, expires_in: 3599 });
    }
    if (url.startsWith("https://oauth2.googleapis.com/revoke")) return new Response("{}");
    return new Response("?", { status: 500 });
  }) as typeof fetch;
  const env: Env = { GOOGLE_CLIENT_ID: "cid.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "GOCSPX-fixture", RATE_SECRET: "rate-secret-0123456789", STATE_SECRET: "state-secret-0123456789",
    MODE: "test", RELAY_URL: "https://connect.test", __store: store, __fetch, __now: () => Date.parse("2026-11-13T10:00:00Z"), ...over };
  return { store, calls, env };
}
const post = (path: string, body: unknown, env: Env) => handle(new Request(`https://connect.test${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), env);
const get = (path: string, env: Env) => handle(new Request(`https://connect.test${path}`), env);

async function authorize(env: Env) {
  const s = await (await post("/v1/google/start", { instance_id: "inst-1234", return_url: "https://instance.test/api/google-oauth/callback", code_challenge: challenge }, env)).json() as any;
  const state = new URL(s.authorize_url).searchParams.get("state")!;
  return { state, s };
}

test("parcours complet : page d'accord, redirection Google (hors ligne, deux permissions), code, jeton remis une seule fois", async () => {
  const { env, store, calls } = setup();
  const { state, s } = await authorize(env);
  assert.match(s.authorize_url, /^https:\/\/connect\.test\/google\/authorize/);
  const page = await (await get(`/google/authorize?state=${encodeURIComponent(state)}`, env)).text();
  assert.match(page, /instance\.test/); assert.match(page, /ne lit pas votre agenda/);

  const go = await get(`/google/go?state=${encodeURIComponent(state)}`, env);
  assert.equal(go.status, 302);
  const g = new URL(go.headers.get("location")!);
  assert.equal(g.origin + g.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(g.searchParams.get("access_type"), "offline"); assert.equal(g.searchParams.get("prompt"), "consent");
  assert.equal(g.searchParams.get("scope"), SCOPES); assert.equal(g.searchParams.get("redirect_uri"), "https://connect.test/google/callback");
  assert.ok(!go.headers.get("location")!.includes("GOCSPX"), "le secret ne part jamais vers le navigateur");

  const cb = await get(`/google/callback?code=4/abc&state=${encodeURIComponent(state)}`, env);
  assert.equal(cb.status, 302);
  assert.match(calls.at(-1)!.body, /client_secret=GOCSPX-fixture/); assert.match(calls.at(-1)!.body, /code=4%2Fabc/);
  const back = new URL(cb.headers.get("location")!); const code = back.searchParams.get("code")!;
  assert.equal(back.origin, "https://instance.test");
  assert.ok(![...store.gcodes.values()].some((g) => g.blob.includes(REFRESH)), "jeton chiffré au repos");

  assert.equal((await post("/v1/google/token", { code, code_verifier: "w".repeat(43), instance_id: "inst-1234" }, env)).status, 400, "mauvais vérificateur");
  assert.equal((await post("/v1/google/token", { code, code_verifier: verifier, instance_id: "autre-instance" }, env)).status, 400, "autre instance");
  const ok = await post("/v1/google/token", { code, code_verifier: verifier, instance_id: "inst-1234" }, env);
  assert.deepEqual(await ok.json(), { refresh_token: REFRESH }, "les essais ratés n'ont pas brûlé le code");
  assert.equal((await post("/v1/google/token", { code, code_verifier: verifier, instance_id: "inst-1234" }, env)).status, 400, "usage unique");
  assert.ok([...store.gcodes.values()].every((g) => g.blob === ""), "rien n'est gardé après la remise");
});

test("autorisation partielle : une permission décochée → jeton révoqué chez Google, rien remis", async () => {
  const { env, calls, store } = setup({}, "https://www.googleapis.com/auth/calendar.events");
  const { state } = await authorize(env);
  const cb = await get(`/google/callback?code=4/abc&state=${encodeURIComponent(state)}`, env);
  assert.equal(new URL(cb.headers.get("location")!).searchParams.get("error"), "missing_scope");
  assert.ok(calls.some((c) => c.url.startsWith("https://oauth2.googleapis.com/revoke")));
  assert.equal(store.gcodes.size, 0);
});

test("refus de l'utilisateur et state rejoué", async () => {
  const { env } = setup();
  const { state } = await authorize(env);
  const cb = await get(`/google/callback?error=access_denied&state=${encodeURIComponent(state)}`, env);
  assert.equal(new URL(cb.headers.get("location")!).searchParams.get("error"), "access_denied");
  assert.equal((await get(`/google/callback?code=x&state=${encodeURIComponent(state)}`, env)).status, 410);
  assert.equal((await get("/google/authorize?state=forge.faux", env)).status, 400);
});

test("jeton d'accès : renvoyé sans rien garder ; accès retiré chez Google → 401 reconnect ; URL de retour http refusée", async () => {
  const { env, store } = setup();
  const r = await post("/v1/google/refresh", { refresh_token: REFRESH }, env);
  assert.deepEqual(await r.json(), { access_token: "ya29.FIXTURE", expires_in: 3599 });
  assert.equal((await post("/v1/google/refresh", { refresh_token: "revoked-" + REFRESH }, env)).status, 401);
  assert.equal((await post("/v1/google/refresh", { refresh_token: "court" }, env)).status, 400);
  assert.equal((await post("/v1/google/revoke", { refresh_token: REFRESH }, env)).status, 200);
  assert.equal(store.tokens.size, 0);
  const bad = await post("/v1/google/start", { instance_id: "inst-1234", return_url: "http://evil.test/cb", code_challenge: challenge }, env);
  assert.equal(bad.status, 400);
});

test("limite par jeton, et relais sans application Google : 503", async () => {
  const { env } = setup();
  for (let i = 0; i < 240; i++) assert.equal((await post("/v1/google/refresh", { refresh_token: REFRESH }, env)).status, 200);
  assert.equal((await post("/v1/google/refresh", { refresh_token: REFRESH }, env)).status, 429);
  assert.equal((await post("/v1/google/start", {}, setup({ GOOGLE_CLIENT_SECRET: undefined }).env)).status, 503);
});
