// T18 : retrait d'une connexion (CA17), remplacement de la clé sous le même id (CA18), variable d'environnement explicite prioritaire (CA20).
// Fournisseurs SIMULÉS (server/connectors/sim.ts).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { db } from "./db.ts";
import { markAdmin, markClient } from "./admin.ts";
import { connections, getSecrets } from "./connections.ts";
import { registerConnections, setConnectorContext, SOURCE_RETIREE } from "./connectors/api.ts";
import { setCollectContext } from "./connectors/use.ts";
import { simCtx } from "./connectors/sim.ts";
import { GOOGLE_JSON, FIXTURES } from "./connectors/fixtures.ts";
import { registerSources, projectSources } from "./sources.ts";
import { collect, measure, record, registerProjects, saveIndicator, saveProject, RESERVED_ENV } from "./projects.ts";
import type { PgPoolLike } from "./connectors/types.ts";

process.env.SECRET = "t".repeat(40);
const A = "rk_" + "test_PremiereCle0123456789ab", B = "rk_" + "test_SecondeCle0123456789abc";
const seen: { url: string; auth?: string; ctxHeader?: string }[] = []; const pgUrls: string[] = [];
const pool: PgPoolLike = { connect: async () => ({ query: async (sql: string) => ({ rows: FIXTURES.postgres.sql!(sql) }), release() {} }), end: async () => {} };
const base = simCtx();
const ctx = simCtx({
  fetch: (async (u: any, i: RequestInit = {}) => { const h = (i.headers ?? {}) as Record<string, string>; seen.push({ url: String(u), auth: h.Authorization, ctxHeader: h["Stripe-Context"] }); return base.fetch(u, i); }) as typeof fetch,
  pg: (url) => { pgUrls.push(url); return pool; },
});
const admin = new Hono(); admin.use("*", (c, n) => { markAdmin(c); return n(); }); registerConnections(admin); registerSources(admin); registerProjects(admin);
const agent = new Hono(); agent.use("*", (c, n) => { markClient(c); return n(); }); registerProjects(agent); registerConnections(agent);
const call = (a: Hono, method: string, path: string, body?: unknown) => a.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const connect = async (kind: string, values: Record<string, string>, label = "") => (await (await call(admin, "POST", "/api/connections", { kind, label, values })).json()).connection as any;
beforeEach(() => { process.env.SECRET = "t".repeat(40); seen.length = 0; pgUrls.length = 0; db.exec("DELETE FROM connections; DELETE FROM indicators; DELETE FROM projects; DELETE FROM metrics;"); setConnectorContext(ctx); setCollectContext(ctx); });

test("CA17 : la confirmation cite les 2 indicateurs ; après retrait ils existent, l'historique est intact, leur statut vaut « Source retirée »", async () => {
  const c = await connect("stripe", { key: A }, "Compte à retirer");
  const p = saveProject(null, { name: "Boutique" })!, q = saveProject(null, { name: "Autre projet" })!;
  const mrr = saveIndicator(null, p.id, { label: "MRR", mode: "total", source: "stripe", config: { metric: "mrr", connection_id: c.id } })!;
  const rev = saveIndicator(null, q.id, { label: "CA net", mode: "daily", source: "stripe", config: { metric: "revenue", connection_id: c.id } })!;
  saveIndicator(null, p.id, { label: "Saisie", mode: "total", source: "manual" }); // non concerné
  await collect(mrr); record(rev.id, "2026-11-08", 12); record(rev.id, "2026-11-09", 10);
  const history = (db.prepare("SELECT indicator_id, day, value FROM metrics ORDER BY indicator_id, day").all() as any[]).map((x) => ({ ...x }));
  assert.ok(history.length >= 3);

  const usage = await (await call(admin, "GET", `/api/connections/${c.id}/usage`)).json();
  assert.deepEqual(usage.indicators.map((i: any) => `${i.label} (${i.project})`).sort(), ["CA net (Autre projet)", "MRR (Boutique)"]);
  assert.equal(usage.revokeUrl, "https://dashboard.stripe.com/apikeys"); assert.equal(usage.provider, "Stripe"); assert.equal(usage.label, "Compte à retirer");

  const r = await call(admin, "DELETE", `/api/connections/${c.id}`);
  assert.deepEqual(await r.json(), { ok: true, affected: 2 });
  assert.equal(connections().length, 0, "la ligne et ses secrets ont disparu");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM indicators WHERE project_id IN (?, ?)").get(p.id, q.id) as any).n, 3, "les indicateurs existent toujours");
  assert.deepEqual((db.prepare("SELECT indicator_id, day, value FROM metrics ORDER BY indicator_id, day").all() as any[]).map((x) => ({ ...x })), history, "historique intact");
  for (const id of [mrr.id, rev.id]) assert.equal((db.prepare("SELECT last_error FROM indicators WHERE id = ?").get(id) as any).last_error, SOURCE_RETIREE);
  assert.equal((db.prepare("SELECT last_error FROM indicators WHERE label = 'Saisie'").get() as any).last_error, null);
  // la section Sources du projet l'indique ; un relevé ultérieur garde le statut au lieu de planter
  assert.equal(projectSources(p.id)!.groups[0].connection, null);
  await assert.rejects(collect(mrr), /^Error: Source retirée/);
  assert.match((db.prepare("SELECT last_error FROM indicators WHERE id = ?").get(mrr.id) as any).last_error, /^Source retirée/);
  assert.equal((await call(admin, "GET", `/api/connections/${c.id}/usage`)).status, 404);
});

test("retirer une connexion qu'aucun indicateur n'utilise : « affected: 0 » ; réservé à l'administrateur", async () => {
  const c = await connect("stripe", { key: A });
  assert.deepEqual((await (await call(admin, "GET", `/api/connections/${c.id}/usage`)).json()).indicators, []);
  assert.equal((await call(agent, "GET", `/api/connections/${c.id}/usage`)).status, 403);
  assert.equal((await call(agent, "DELETE", `/api/connections/${c.id}`)).status, 403);
  assert.deepEqual(await (await call(admin, "DELETE", `/api/connections/${c.id}`)).json(), { ok: true, affected: 0 });
});

test("un indicateur « Source retirée » repart en pointant une autre connexion (le statut disparaît au relevé réussi)", async () => {
  const c1 = await connect("stripe", { key: A }, "Ancienne");
  const p = saveProject(null, { name: "Reprise" })!;
  const ind = saveIndicator(null, p.id, { label: "MRR", mode: "total", source: "stripe", config: { metric: "mrr", connection_id: c1.id } })!;
  await call(admin, "DELETE", `/api/connections/${c1.id}`);
  const c2 = await connect("stripe", { key: B }, "Nouvelle");
  const ok = await call(admin, "PATCH", `/api/indicators/${ind.id}`, { config: { metric: "mrr", connection_id: c2.id } });
  assert.equal(ok.status, 200);
  assert.equal((db.prepare("SELECT last_error FROM indicators WHERE id = ?").get(ind.id) as any).last_error, null);
});

test("CA18 : « Remplacer la clé » garde l'id, les indicateurs relèvent avec la nouvelle clé ; un remplacement refusé garde l'ancienne", async () => {
  const c = await connect("stripe", { key: A }, "Mon compte");
  const p = saveProject(null, { name: "Rotation" })!;
  const ind = saveIndicator(null, p.id, { label: "MRR", mode: "total", source: "stripe", config: { metric: "mrr", connection_id: c.id } })!;
  seen.length = 0; assert.equal(await measure(ind), 29); assert.equal(seen[0].auth, `Bearer ${A}`);
  const history = (db.prepare("SELECT COUNT(*) AS n FROM metrics").get() as any).n;

  // remplacement refusé par le fournisseur : l'ancienne clé reste
  setConnectorContext(simCtx({ fetch: (async () => new Response("{}", { status: 401 })) as typeof fetch }));
  assert.equal((await call(admin, "PATCH", `/api/connections/${c.id}`, { values: { key: B } })).status, 400);
  assert.equal(getSecrets(c.id).key, A);
  setConnectorContext(ctx);

  const r = await call(admin, "PATCH", `/api/connections/${c.id}`, { values: { key: B } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).connection.id, c.id, "même id");
  assert.equal(connections().length, 1); assert.equal(connections()[0].id, c.id);
  assert.equal(getSecrets(c.id).key, B);
  seen.length = 0; assert.equal(await measure(ind), 29);
  assert.equal(seen[0].auth, `Bearer ${B}`, "le relevé utilise la nouvelle clé sans toucher à l'indicateur");
  assert.equal(JSON.parse((db.prepare("SELECT config FROM indicators WHERE id = ?").get(ind.id) as any).config).connection_id, c.id, "l'indicateur n'a pas bougé");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM metrics").get() as any).n, history, "historique conservé");
});

test("CA20 : un indicateur avec config.env explicite est relevé par la variable, même si une connexion existe (5 sources)", async () => {
  const p = saveProject(null, { name: "Env" })!;
  const stripe = await connect("stripe", { key: A }); const ps = await connect("pagespeed", { key: "cle-connexion-PS-0123456789ab" });
  const pgc = await connect("postgres", { url: "postgres://searchtide_ro:" + "ConnexionPw0123@db.exemple.test:5432/produit" });
  const js = await connect("jsonapi", { origin: "https://api.exemple.test", token: "tok_" + "CONNEXION0123456789abcdef" });
  await connect("google", { json: GOOGLE_JSON, playBucket: "gs://pubsite_prod_rev_00000000000000000001" });
  process.env.CA20_STRIPE = "sk_" + "org_variable0123456789"; process.env.CA20_PS = "cle-variable-PS-0123456789abcdef";
  process.env.CA20_PG = "postgres://lecteur:" + "VariablePw0123@variable.exemple.test:5432/autre"; process.env.CA20_HTTP = "jeton-variable-0123456789";
  process.env.CA20_BUCKET = "gs://pubsite_prod_rev_00000000000000000002"; process.env.GOOGLE_SERVICE_ACCOUNT_JSON = GOOGLE_JSON;
  const mk = (source: string, mode: string, config: Record<string, unknown>) => saveIndicator(null, p.id, { label: `${source}-env`, mode, source, config })!;

  seen.length = 0; await measure(mk("stripe", "total", { metric: "active_subscriptions", env: "CA20_STRIPE", account: "acct_1", connection_id: stripe.id }));
  assert.equal(seen[0].auth, `Bearer ${process.env.CA20_STRIPE}`); assert.equal(seen[0].ctxHeader, "acct_1", "clé d'organisation : Stripe-Context");
  seen.length = 0; await measure(mk("pagespeed", "total", { url: "https://exemple.com/", metric: "seo", env: "CA20_PS", connection_id: ps.id }));
  assert.match(seen[0].url, /key=cle-variable-PS/); assert.doesNotMatch(seen[0].url, /cle-connexion-PS/);
  await measure(mk("pg", "total", { sql: "SELECT COUNT(*) FROM users", env: "CA20_PG", connection_id: pgc.id }));
  assert.equal(pgUrls.at(-1), process.env.CA20_PG);
  seen.length = 0; await measure(mk("http", "total", { url: "https://api.exemple.test/stats", path: "stats.users", env: "CA20_HTTP", connection_id: js.id }));
  assert.equal(seen[0].auth, `Bearer ${process.env.CA20_HTTP}`);
  seen.length = 0; await measure(mk("play", "total", { package: "com.exemple.app", metric: "rating", env: "CA20_BUCKET" }));
  assert.ok(seen.some((s) => s.url.includes("pubsite_prod_rev_00000000000000000002")), "le bucket vient de la variable");
  assert.ok(!seen.some((s) => s.url.includes("pubsite_prod_rev_00000000000000000001")), "pas celui de la connexion");
  // sans `env`, la connexion reprend la main
  seen.length = 0; await measure(mk("pagespeed", "total", { url: "https://exemple.com/", metric: "seo", connection_id: ps.id }));
  assert.match(seen[0].url, /key=cle-connexion-PS/);
});

test("variables réservées : un indicateur ne peut pas lire SECRET, ADMIN_PASSWORD, API_KEY… (ni via l'API avec une clé d'agent)", async () => {
  const p = saveProject(null, { name: "Garde" })!;
  for (const name of ["SECRET", "ADMIN_PASSWORD", "API_KEY", "API_KEY_READ", "TOTP_SECRET", "INBOUND_KEY", "SMTP_URL", "GOOGLE_SERVICE_ACCOUNT_JSON"]) {
    assert.ok(RESERVED_ENV.has(name));
    assert.throws(() => saveIndicator(null, p.id, { label: "x", mode: "total", source: "http", config: { url: "https://pirate.exemple.test/", env: name } }), /Variable réservée/, name);
  }
  const r = await call(agent, "POST", `/api/projects/${p.id}/indicators`, { label: "x", mode: "total", source: "http", config: { url: "https://pirate.exemple.test/", env: "ADMIN_PASSWORD" } });
  assert.equal(r.status, 400); assert.match((await r.json()).error, /Variable réservée/);
  // même une ligne déjà en base (créée avant la garde) ne livre rien
  db.prepare("INSERT INTO indicators (id, project_id, label, mode, source, config, position, created_at) VALUES ('vieux', ?, 'vieux', 'total', 'http', ?, 0, 0)").run(p.id, JSON.stringify({ url: "https://pirate.exemple.test/", env: "SECRET" }));
  seen.length = 0;
  await assert.rejects(measure({ id: "vieux", source: "http", mode: "total", config: { url: "https://pirate.exemple.test/", env: "SECRET" } }), /réservée à Searchtide/);
  assert.equal(seen.length, 0, "aucune requête n'est partie");
  assert.equal((await call(agent, "POST", `/api/projects/${p.id}/indicators`, { label: "ok", mode: "total", source: "manual" })).status, 201, "le reste fonctionne");
});
