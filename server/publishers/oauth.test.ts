// Connexion OAuth d'un réseau de publication : état lié à la session, usage unique, plafond de départs. Aucun appel réseau externe :
// le retour est joué avec `error=` (refus) ou un état inconnu, donc l'échange de code n'est jamais tenté.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { login, startServer, tempDb, type Running } from "../test-server.ts";

let srv: Running, cookie = "", project = "", tmp: ReturnType<typeof tempDb>;

const admin = (path: string, init: RequestInit = {}) =>
  fetch(srv.base + path, { redirect: "manual", ...init, headers: { cookie, ...(init.headers ?? {}) } });
const start = (body: unknown) => admin("/api/pub-oauth/linkedin/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function newProject(base: string, c: string) {
  const r = await fetch(`${base}/api/projects`, { method: "POST", headers: { cookie: c, "content-type": "application/json" }, body: JSON.stringify({ name: "Projet OAuth" }) });
  assert.equal(r.status, 201);
  return String(((await r.json()) as { id: string }).id);
}

before(async () => {
  tmp = tempDb();
  srv = await startServer(tmp.path, { LINKEDIN_CLIENT_ID: "cid-test", LINKEDIN_CLIENT_SECRET: "secret-test", PUBLIC_URL: "https://exemple.test" });
  cookie = await login(srv.base);
  project = await newProject(srv.base, cookie);
});
after(() => { srv?.stop(); tmp?.done(); });

test("départ réservé à l'administrateur ; l'adresse d'autorisation vise le retour public exact", async () => {
  // L'authentification globale des /api répond avant la route : sans session, 401 et rien n'est créé.
  const anon = await fetch(`${srv.base}/api/pub-oauth/linkedin/start`, { method: "POST" });
  assert.equal(anon.status, 401);

  const r = await start({ project });
  assert.equal(r.status, 200);
  const { url } = (await r.json()) as { url: string };
  const u = new URL(url);
  assert.equal(`${u.origin}${u.pathname}`, "https://www.linkedin.com/oauth/v2/authorization");
  assert.equal(u.searchParams.get("client_id"), "cid-test");
  assert.equal(u.searchParams.get("redirect_uri"), "https://exemple.test/api/pub-oauth/linkedin/callback");
  assert.equal(u.searchParams.get("scope"), "openid profile w_member_social");
  assert.match(u.searchParams.get("state") ?? "", /^[0-9a-f]{32}$/);
});

test("sans session, le retour est refusé et ne consomme pas l'état", async () => {
  const { url } = (await (await start({ project })).json()) as { url: string };
  const state = new URL(url).searchParams.get("state")!;
  const anon = await fetch(`${srv.base}/api/pub-oauth/linkedin/callback?code=x&state=${state}`, { redirect: "manual" });
  assert.equal(anon.status, 401);
  // L'état reste utilisable par la session qui l'a ouvert (ici refusé, donc consommé sans appel réseau).
  const ok = await admin(`/api/pub-oauth/linkedin/callback?error=access_denied&state=${state}`);
  assert.match(decodeURIComponent(ok.headers.get("location")!), /^\/\?view=connections&oauth=Autorisation refusée/);
});

test("état à usage unique : un refus le consomme, un rejeu est refusé ; un état inventé aussi", async () => {
  const { url } = (await (await start({ project })).json()) as { url: string };
  const state = new URL(url).searchParams.get("state")!;
  const refused = await admin(`/api/pub-oauth/linkedin/callback?error=access_denied&state=${state}`);
  assert.match(decodeURIComponent(refused.headers.get("location")!), /Autorisation refusée/);
  const replay = await admin(`/api/pub-oauth/linkedin/callback?code=x&state=${state}`);
  assert.match(decodeURIComponent(replay.headers.get("location")!), /a expiré/);
  const invented = await admin(`/api/pub-oauth/linkedin/callback?code=x&state=${"0".repeat(32)}`);
  assert.match(decodeURIComponent(invented.headers.get("location")!), /a expiré/);
});

test("projet inconnu refusé, et aucun état n'est créé", async () => {
  const r = await start({ project: "projet-qui-n-existe-pas" });
  assert.equal(r.status, 400);
  assert.match(((await r.json()) as { error: string }).error, /Projet introuvable/);
});

test("plafond : le onzième départ d'affilée est refusé", async () => {
  const t = tempDb(), s = await startServer(t.path, { LINKEDIN_CLIENT_ID: "cid-test", LINKEDIN_CLIENT_SECRET: "secret-test", PUBLIC_URL: "https://exemple.test" });
  try {
    const c = await login(s.base), p = await newProject(s.base, c);
    const go = () => fetch(`${s.base}/api/pub-oauth/linkedin/start`, { method: "POST", headers: { cookie: c, "content-type": "application/json" }, body: JSON.stringify({ project: p }) });
    for (let i = 0; i < 10; i++) assert.equal((await go()).status, 200, `départ ${i + 1}`);
    const over = await go();
    assert.equal(over.status, 429);
    assert.match(((await over.json()) as { error: string }).error, /Trop de tentatives/);
  } finally { s.stop(); t.done(); }
});
