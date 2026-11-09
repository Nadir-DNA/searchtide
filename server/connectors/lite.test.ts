// Tests T15 : connecteurs PageSpeed et API JSON. Google PageSpeed et l'API JSON sont SIMULÉS (aucune requête réelle).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { db } from "../db.ts";
import { markAdmin } from "../admin.ts";
import { connections } from "../connections.ts";
import { registerConnections, setConnectorContext } from "./api.ts";
import { setCollectContext } from "./use.ts";
import { get, realCtx, runTest } from "./registry.ts";
import { checkContract } from "./contract.ts";
import { FIXTURES } from "./fixtures.ts";
import { measure, saveIndicator, saveProject } from "../projects.ts";
import { parseOrigin, pickNumber } from "./jsonapi.ts";
import "./index.ts";

process.env.SECRET = "t".repeat(40);
type Seen = { url: string; headers: Record<string, string>; redirect?: string };
const seen: Seen[] = [];
let reply: ((url: string) => Response | Promise<Response> | undefined) | null = null;
const sim = realCtx({
  fetch: (async (u: any, i: RequestInit = {}) => {
    const url = String(u); seen.push({ url, headers: (i.headers ?? {}) as Record<string, string>, redirect: i.redirect });
    const r = reply?.(url); if (r) return r;
    return (url.includes("pagespeedonline") ? FIXTURES.pagespeed : FIXTURES.jsonapi).respond!(url, i);
  }) as typeof fetch,
});
const admin = new Hono(); admin.use("*", (c, n) => { markAdmin(c); return n(); }); registerConnections(admin);
const post = (body: unknown) => admin.request("/api/connections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
beforeEach(() => { seen.length = 0; reply = null; delete process.env.PAGESPEED_KEY; delete process.env.MON_JETON; process.env.SECRET = "t".repeat(40); db.exec("DELETE FROM connections"); setConnectorContext(sim); setCollectContext(sim); });

// ───────── PageSpeed ─────────
const KEY = "AIza" + "SyDemoKeyPageSpeed0123456789xyz";

test("contrat commun : PageSpeed et API JSON sont conformes", async () => {
  for (const id of ["pagespeed", "jsonapi"]) assert.deepEqual(await checkContract(get(id)!, FIXTURES[id]), [], id);
});

test("PageSpeed : clé acceptée par Google, indice « clé …xyz », un seul compte", async () => {
  const r = await post({ kind: "pagespeed", values: { key: KEY } });
  const text = await r.text(); assert.equal(r.status, 201, text);
  assert.doesNotMatch(text, /SyDemoKeyPageSpeed/);
  const j = JSON.parse(text);
  assert.equal(j.test.detail, "Clé acceptée par Google."); assert.deepEqual(j.test.warnings, []); assert.equal(j.connection.hint, "clé …9xyz");
  assert.match(seen[0].url, new RegExp(`key=${KEY}`)); assert.equal((await post({ kind: "pagespeed", values: { key: KEY + "2" } })).status, 409);
});

test("PageSpeed sans clé : accepté avec un avertissement sur le quota partagé", async () => {
  const r = await post({ kind: "pagespeed", values: {} });
  assert.equal(r.status, 201);
  const j = await r.json();
  assert.equal(j.connection.hint, "sans clé"); assert.match(j.test.warnings[0], /Sans clé, Google peut limiter les relevés/);
  assert.doesNotMatch(seen[0].url, /key=/);
});

test("PageSpeed refusé : clé invalide (400), API non activée (403), quota (429) — aucune ligne", async () => {
  reply = () => json({ error: { message: "API key not valid. Please pass a valid API key.", errors: [{ reason: "keyInvalid" }] } }, 400);
  assert.equal((await (await post({ kind: "pagespeed", values: { key: KEY } })).json()).error, "PageSpeed refuse cette clé : vérifiez qu'elle est complète et active.");
  reply = () => json({ error: { message: "API has not been used in project" } }, 403);
  assert.match((await (await post({ kind: "pagespeed", values: { key: KEY } })).json()).error, /activez l'API PageSpeed Insights/);
  reply = () => json({ error: { message: "Quota exceeded" } }, 429);
  assert.match((await (await post({ kind: "pagespeed", values: {} })).json()).error, /Quota PageSpeed dépassé/);
  assert.equal(connections().length, 0);
});

test("PageSpeed : si Lighthouse tourne encore (aucune erreur de clé au bout de 60 % du délai), la clé est acceptée", async () => {
  const slow = realCtx({ timeoutMs: 200, fetch: ((_u: any, i: RequestInit = {}) => new Promise((_res, rej) => i.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))))) as typeof fetch });
  const r = await runTest(get("pagespeed")!, { config: {}, secrets: { key: KEY } }, slow);
  assert.equal(r.ok, true); assert.equal(r.detail, "Clé acceptée par Google.");
});

test("PageSpeed : les 4 mesures d'une page (note sur 100, LCP en secondes, CLS) depuis la connexion", async () => {
  await post({ kind: "pagespeed", values: { key: KEY } });
  const p = saveProject(null, { name: "Vitesse" })!;
  const mk = (metric: string, strategy = "mobile") => saveIndicator(null, p.id, { label: metric, mode: "total", source: "pagespeed", config: { url: "https://exemple.com/", metric, strategy } })!;
  seen.length = 0;
  assert.equal(await measure(mk("performance")), 87);
  assert.equal(await measure(mk("seo")), 92);
  assert.equal(await measure(mk("lcp")), 2.35);
  assert.equal(await measure(mk("cls")), 0.046);
  assert.match(seen[0].url, /strategy=mobile/); assert.match(seen[0].url, new RegExp(`key=${KEY}`)); assert.match(seen[0].url, /url=https%3A%2F%2Fexemple\.com%2F/);
  seen.length = 0; await measure(mk("performance", "desktop")); assert.match(seen[0].url, /strategy=desktop/);
});

test("PageSpeed : ancien mode — la variable PAGESPEED_KEY sert quand aucune connexion n'existe, une variable explicite l'emporte (CA20)", async () => {
  const p = saveProject(null, { name: "Env" })!;
  const ind = saveIndicator(null, p.id, { label: "perf", mode: "total", source: "pagespeed", config: { url: "https://exemple.com/", metric: "performance" } })!;
  await assert.rejects(measure(ind), /PAGESPEED_KEY absente/);
  process.env.PAGESPEED_KEY = "cle-env-PS-0123456789abcdefghij";
  seen.length = 0; assert.equal(await measure(ind), 87); assert.match(seen[0].url, /key=cle-env-PS/);
  await post({ kind: "pagespeed", values: { key: KEY } });
  seen.length = 0; await measure(ind); assert.match(seen[0].url, new RegExp(`key=${KEY}`), "la connexion remplace la variable par défaut");
  process.env.MA_CLE_PS = "cle-explicite-0123456789abcdefghij";
  const explicit = saveIndicator(null, p.id, { label: "perf2", mode: "total", source: "pagespeed", config: { url: "https://exemple.com/", metric: "performance", env: "MA_CLE_PS" } })!;
  seen.length = 0; await measure(explicit); assert.match(seen[0].url, /key=cle-explicite/, "env explicite prioritaire");
});

// ───────── API JSON ─────────
const TOKEN = "tok_Prod_7Hq2LmZx9VbN4cRtYw81";
const API = { kind: "jsonapi", values: { origin: "https://api.exemple.test", token: TOKEN } };

test("API JSON : domaine autorisé validé (https, ou http pour localhost seulement)", () => {
  assert.equal(parseOrigin("https://api.exemple.test/ignore").origin, "https://api.exemple.test");
  assert.equal(parseOrigin("http://localhost:8080").origin, "http://localhost:8080");
  assert.throws(() => parseOrigin("http://api.exemple.test"), /https:\/\//);
  assert.throws(() => parseOrigin("api.exemple.test"), /ressembler à https/);
  assert.equal(pickNumber({ a: { b: [{ c: "12.5" }] } }, "a.b.0.c"), 12.5);
  assert.throws(() => pickNumber({ a: "x" }, "a"), /Pas de nombre à « a »/);
  assert.equal(pickNumber(7, ""), 7);
});

test("API JSON : le test appelle le domaine autorisé avec le jeton (Bearer ajouté), le jeton n'est jamais renvoyé", async () => {
  const r = await post({ ...API, label: "Mon API" });
  const text = await r.text(); assert.equal(r.status, 201, text);
  assert.doesNotMatch(text, /7Hq2LmZx9VbN4cRtYw81/);
  const j = JSON.parse(text);
  assert.equal(j.connection.label, "Mon API"); assert.equal(j.connection.hint, "api.exemple.test · jeton …Yw81"); assert.equal(j.test.detail, "api.exemple.test répond (HTTP 200).");
  assert.equal(seen[0].url, "https://api.exemple.test/"); assert.equal(seen[0].headers.Authorization, `Bearer ${TOKEN}`); assert.equal(seen[0].redirect, "manual");
  assert.equal((await post({ ...API, label: "Autre", values: { ...API.values, token: TOKEN + "2" } })).status, 201, "plusieurs API possibles");
});

test("API JSON : en-tête personnalisé envoyé tel quel, sans jeton aucun en-tête d'accès ; 401, 403, 5xx, redirection", async () => {
  await post({ kind: "jsonapi", values: { origin: "https://api.exemple.test", header: "X-Api-Key", token: "cle-brute-0123456789" } });
  assert.equal(seen[0].headers["X-Api-Key"], "cle-brute-0123456789"); assert.equal(seen[0].headers.Authorization, undefined);
  db.exec("DELETE FROM connections"); seen.length = 0;
  await post({ kind: "jsonapi", values: { origin: "https://api.exemple.test" } });
  assert.deepEqual(Object.keys(seen[0].headers), ["Accept"]);
  for (const [status, re] of [[401, /refuse ce jeton/], [403, /Permission manquante/], [500, /erreur 500/], [302, /redirige ailleurs/]] as const) {
    reply = () => new Response("", { status });
    assert.match((await (await post({ ...API, values: { ...API.values, token: TOKEN + status } })).json()).error, re, String(status));
  }
  assert.equal(connections().length, 1, "seule la création sans jeton a réussi");
});

test("API JSON : relevé via la connexion — chemin, tableau, mauvaise réponse ; jamais d'envoi du jeton hors du domaine autorisé", async () => {
  const c = await (await post(API)).json();
  const p = saveProject(null, { name: "API" })!;
  const mk = (url: string, path: string, mode: "daily" | "total" = "total") => saveIndicator(null, p.id, { label: path || "racine", mode, source: "http", config: { url, path, connection_id: c.connection.id } })!;
  seen.length = 0;
  assert.equal(await measure(mk("https://api.exemple.test/stats", "stats.users")), 128);
  assert.equal(seen[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(await measure(mk("https://api.exemple.test/stats", "stats.users", "daily"), "2026-11-09"), 128);
  reply = () => json({ stats: { users: "beaucoup" } });
  await assert.rejects(measure(mk("https://api.exemple.test/stats", "stats.users")), /Pas de nombre à « stats\.users »/);
  reply = () => new Response("<html>", { status: 200 });
  await assert.rejects(measure(mk("https://api.exemple.test/stats", "stats.users")), /n'est pas du JSON/);
  seen.length = 0; reply = null;
  await assert.rejects(measure(mk("https://pirate.exemple.test/vole", "x")), /pas sur le domaine autorisé/);
  await assert.rejects(measure(mk("https://api.exemple.test.pirate.test/stats", "x")), /pas sur le domaine autorisé/);
  assert.equal(seen.length, 0, "aucune requête, donc aucun jeton envoyé");
  reply = () => new Response("", { status: 401 });
  await assert.rejects(measure(mk("https://api.exemple.test/stats", "stats.users")), /refuse ce jeton/);
  assert.equal(connections()[0].status, "reconnect");
});

test("API JSON : ancien mode — adresse libre sans connexion, jeton facultatif par config.env, comportement conservé", async () => {
  const p = saveProject(null, { name: "Ancien" })!;
  const open = saveIndicator(null, p.id, { label: "public", mode: "total", source: "http", config: { url: "https://api.exemple.test/stats", path: "stats.users" } })!;
  seen.length = 0; assert.equal(await measure(open), 128); assert.deepEqual(seen[0].headers, {});
  process.env.MON_JETON = "jeton-env-0123456789";
  const withEnv = saveIndicator(null, p.id, { label: "env", mode: "total", source: "http", config: { url: "https://api.exemple.test/stats", path: "stats.users", env: "MON_JETON" } })!;
  seen.length = 0; await measure(withEnv); assert.equal(seen[0].headers.Authorization, "Bearer jeton-env-0123456789");
});
