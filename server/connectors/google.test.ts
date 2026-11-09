// Tests T13 : connexion Google (compte de service) pour Search Console et Google Play. Google SIMULÉ : aucune requête réelle.
// La clé RSA du compte de service est générée pour le test et n'ouvre rien.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { db } from "../db.ts";
import { markAdmin } from "../admin.ts";
import { connections } from "../connections.ts";
import { registerConnections, setConnectorContext } from "./api.ts";
import { setCollectContext } from "./use.ts";
import { clearGoogleTokens } from "./google.ts";
import { get, realCtx } from "./registry.ts";
import { checkContract } from "./contract.ts";
import { FIXTURES, GOOGLE_EMAIL, GOOGLE_JSON } from "./fixtures.ts";
import { gscConfigured, syncSite } from "../gsc.ts";
import { measure, saveIndicator, saveProject } from "../projects.ts";
import "./index.ts";

process.env.SECRET = "t".repeat(40);
const fx = FIXTURES.google;
const PRIVATE_FRAGMENT = (JSON.parse(GOOGLE_JSON).private_key as string).split("\n")[3].slice(0, 20); // morceau de la clé privée
type Seen = { method: string; url: string; auth: string | null; body?: string };
const seen: Seen[] = [];
let override: ((url: string, init: RequestInit) => Response | undefined) | null = null;
const sim = realCtx({
  now: () => new Date("2026-11-09T10:00:00Z"),
  fetch: (async (u: any, i: RequestInit = {}) => {
    const url = String(u); seen.push({ method: (i.method ?? "GET").toUpperCase(), url, auth: (i.headers as any)?.Authorization ?? null, body: i.body ? String(i.body) : undefined });
    return override?.(url, i) ?? fx.respond!(url, i);
  }) as typeof fetch,
});
const admin = new Hono(); admin.use("*", (c, n) => { markAdmin(c); return n(); }); registerConnections(admin);
const post = (body: unknown) => admin.request("/api/connections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const BUCKET = "gs://pubsite_prod_rev_01234567890123456789";
beforeEach(() => { seen.length = 0; override = null; clearGoogleTokens(); delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON; delete process.env.PLAY_BUCKET; process.env.SECRET = "t".repeat(40); db.exec("DELETE FROM connections"); setConnectorContext(sim); setCollectContext(sim); });

test("contrat commun : le connecteur Google est conforme (POST de jeton déclaré, lecture seule ensuite)", async () => {
  assert.deepEqual(await checkContract(get("google")!, fx), []);
});

test("création : propriétés Search Console comptées, bucket Play accessible, adresse du compte affichée, clé privée jamais renvoyée (CA6)", async () => {
  const r = await post({ kind: "google", values: { json: GOOGLE_JSON, playBucket: BUCKET } });
  const text = await r.text();
  assert.equal(r.status, 201, text);
  assert.doesNotMatch(text, new RegExp(PRIVATE_FRAGMENT.replace(/[+/]/g, ".")));
  assert.doesNotMatch(text, /private_key/);
  const j = JSON.parse(text);
  assert.equal(j.test.detail, "2 propriétés Search Console, bucket Play accessible");
  assert.equal(j.connection.hint, GOOGLE_EMAIL); assert.equal(j.connection.label, GOOGLE_EMAIL); assert.deepEqual(j.test.warnings, []);
  // seul le jeton est demandé en POST ; tout le reste est en lecture
  assert.deepEqual(seen.filter((s) => s.method !== "GET").map((s) => s.url), ["https://oauth2.googleapis.com/token", "https://oauth2.googleapis.com/token"], "une portée Search Console, une portée stockage");
  assert.ok(seen.some((s) => s.url === "https://searchconsole.googleapis.com/webmasters/v3/sites" && s.auth === "Bearer ya29.FIXTUREaccessTOKENdemo"));
  const list = await (await admin.request("/api/connectors")).text();
  assert.doesNotMatch(list, /private_key|PRIVATE KEY/);
  assert.equal(connections()[0].config.playBucket, BUCKET);
  assert.equal(JSON.parse(list).connectors.find((c: any) => c.id === "google").connections[0].settings.playBucket, BUCKET);
});

test("une même clé collée avec une autre mise en forme est un doublon (JSON compacté avant l'empreinte)", async () => {
  assert.equal((await post({ kind: "google", label: "Premier", values: { json: GOOGLE_JSON } })).status, 201);
  const pretty = JSON.stringify(JSON.parse(GOOGLE_JSON), null, 2);
  const r = await post({ kind: "google", values: { json: pretty } });
  assert.equal(r.status, 409); assert.equal((await r.json()).error, "Cette clé est déjà enregistrée sous « Premier ».");
});

test("mauvais fichier : identifiant OAuth, JSON invalide, clé de compte de service incomplète — aucun appel réseau", async () => {
  const cases: [string, RegExp][] = [
    [JSON.stringify({ installed: { client_id: "x", client_secret: "y" } }), /identifiant OAuth, pas un compte de service/],
    [JSON.stringify({ web: { client_id: "x" } }), /identifiant OAuth, pas un compte de service/],
    ["{pas json", /JSON valide/],
    [JSON.stringify({ type: "service_account", client_email: "a@b.iam.gserviceaccount.com" }), /il manque client_email ou private_key/],
  ];
  for (const [json, re] of cases) { const r = await post({ kind: "google", values: { json } }); assert.equal(r.status, 400); assert.match((await r.json()).error, re); }
  assert.equal(seen.length, 0); assert.equal(connections().length, 0);
});

test("Google valide mais 0 propriété : ENREGISTRÉ avec l'avertissement contenant l'adresse à ajouter", async () => {
  override = (url) => url.includes("webmasters/v3/sites") ? new Response(JSON.stringify({})) : undefined;
  const r = await post({ kind: "google", values: { json: GOOGLE_JSON } });
  assert.equal(r.status, 201);
  const j = await r.json();
  assert.deepEqual(j.test.warnings, [`Aucune propriété visible : ajoutez ${GOOGLE_EMAIL} dans Search Console.`]);
  assert.equal(j.test.detail, "0 propriété Search Console"); assert.equal(connections().length, 1);
});

test("bucket Play inaccessible : ENREGISTRÉ (Search Console fonctionne) avec l'avertissement Play", async () => {
  override = (url) => url.includes("storage.googleapis.com/storage/v1/b/") ? new Response("{}", { status: 403 }) : undefined;
  const r = await post({ kind: "google", values: { json: GOOGLE_JSON, playBucket: BUCKET } });
  assert.equal(r.status, 201);
  assert.deepEqual((await r.json()).test.warnings, ["Play : accès refusé au bucket. Vérifiez l'invitation dans la Play Console (la prise en compte peut prendre du temps)."]);
  assert.equal((await post({ kind: "google", label: "x", values: { json: GOOGLE_JSON.replace("0123456789abcdef0123", "0123456789abcdef9999"), playBucket: "pas un bucket!" } })).status, 400);
});

test("clé refusée par Google (400 invalid_grant) ou API non activée (403) → aucune ligne, messages clairs", async () => {
  override = (url) => url.startsWith("https://oauth2.googleapis.com/token") ? new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }) : undefined;
  let r = await post({ kind: "google", values: { json: GOOGLE_JSON } });
  assert.match((await r.json()).error, /Google refuse cette clé/);
  override = (url) => url.includes("webmasters/v3/sites") ? new Response(JSON.stringify({ error: { message: "API not enabled" } }), { status: 403 }) : undefined;
  r = await post({ kind: "google", values: { json: GOOGLE_JSON } });
  assert.match((await r.json()).error, /activez l'API Search Console/);
  assert.equal(connections().length, 0);
});

test("Search Console : l'import d'un site utilise la connexion Google (jeton de la connexion, propriété du site)", async () => {
  assert.equal(gscConfigured(), false);
  await post({ kind: "google", values: { json: GOOGLE_JSON } });
  assert.equal(gscConfigured(), true);
  db.prepare("INSERT OR REPLACE INTO sites (id, domain, name, gsc_property, created_at) VALUES ('gs1', 'exemple.com', 'exemple.com', 'sc-domain:exemple.com', 0)").run();
  seen.length = 0;
  override = (url, init) => url.includes("/searchAnalytics/query") ? new Response(JSON.stringify({ rows: [{ keys: [JSON.parse(String(init.body)).dimensions.length === 1 ? "2026-11-08" : "2026-11-08", ...(JSON.parse(String(init.body)).dimensions.slice(1).map(() => "x"))], clicks: 3, impressions: 40, position: 7.5 }] })) : undefined;
  const site = db.prepare("SELECT * FROM sites WHERE id = 'gs1'").get() as any;
  const res = await syncSite(site, 3);
  assert.ok(res.rows >= 1);
  const q = seen.filter((s) => s.url.includes("/searchAnalytics/query"));
  assert.ok(q.length >= 3); assert.ok(q.every((s) => s.auth === "Bearer ya29.FIXTUREaccessTOKENdemo"));
  assert.ok((db.prepare("SELECT COUNT(*) AS n FROM gsc_rows WHERE site_id = 'gs1'").get() as any).n >= 1);
});

test("Play : installs par jour, installs actifs et note depuis la connexion (UTF-16 lu), erreurs claires", async () => {
  await post({ kind: "google", values: { json: GOOGLE_JSON, playBucket: BUCKET } });
  const p = saveProject(null, { name: "App Android" })!;
  const mk = (metric: string, mode: "daily" | "total") => saveIndicator(null, p.id, { label: metric, mode, source: "play", config: { package: "com.exemple.app", metric } })!;
  assert.equal(await measure(mk("daily_installs", "daily"), "2026-11-09"), 15);
  assert.equal(await measure(mk("daily_installs", "daily"), "2026-11-08"), 12);
  assert.equal(await measure(mk("active_installs", "total")), 310);
  assert.equal(await measure(mk("rating", "total")), 4.4);
  assert.ok(seen.filter((s) => s.url.includes("storage.googleapis.com")).every((s) => s.method === "GET"), "lecture seule côté Play");
  // paquet inconnu → pas de rapport
  override = (url) => url.includes("stats%2F") ? new Response("", { status: 404 }) : undefined;
  await assert.rejects(measure(mk("rating", "total")), /Aucun rapport Google Play/);
  // accès refusé pendant un relevé → la connexion passe en « à reconnecter »
  override = (url) => url.includes("stats%2F") ? new Response("{}", { status: 403 }) : undefined;
  await assert.rejects(measure(mk("rating", "total")), /accès refusé au bucket/);
  assert.equal(connections()[0].status, "reconnect");
});

test("Play sans bucket dans la connexion : message qui dit quoi faire", async () => {
  await post({ kind: "google", values: { json: GOOGLE_JSON } });
  const p = saveProject(null, { name: "Sans bucket" })!;
  const ind = saveIndicator(null, p.id, { label: "Note", mode: "total", source: "play", config: { package: "com.exemple.app", metric: "rating" } })!;
  await assert.rejects(measure(ind), /Aucun bucket Google Play n'est renseigné/);
});

test("ancien mode conservé : GOOGLE_SERVICE_ACCOUNT_JSON + PLAY_BUCKET sans connexion (CA20)", async () => {
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = GOOGLE_JSON; process.env.PLAY_BUCKET = BUCKET;
  assert.equal(gscConfigured(), true);
  const p = saveProject(null, { name: "Env" })!;
  const ind = saveIndicator(null, p.id, { label: "Note", mode: "total", source: "play", config: { package: "com.exemple.app", metric: "rating" } })!;
  assert.equal(await measure(ind), 4.4);
});
