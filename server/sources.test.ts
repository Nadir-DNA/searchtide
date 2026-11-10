// T17 : rattachement d'une connexion à un projet, section « Sources », devise Stripe, Search Console par site (Q-N4).
// Tous les fournisseurs sont SIMULÉS (server/connectors/sim.ts).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { db } from "./db.ts";
import { markAdmin, markClient } from "./admin.ts";
import { registerConnections, setConnectorContext } from "./connectors/api.ts";
import { setCollectContext } from "./connectors/use.ts";
import { simCtx } from "./connectors/sim.ts";
import { GOOGLE_JSON } from "./connectors/fixtures.ts";
import { registerSources } from "./sources.ts";
import { registerProjects, saveIndicator, saveProject, measure } from "./projects.ts";
import { connections } from "./connections.ts";

process.env.SECRET = "t".repeat(40);
const KEY = "rk_" + "test_Sources0123456789abcd";
const app = new Hono(); app.use("*", (c, n) => { markAdmin(c); return n(); }); registerConnections(app); registerSources(app); registerProjects(app);
const agent = new Hono(); agent.use("*", (c, n) => { markClient(c); return n(); }); registerSources(agent);
const call = (a: Hono, method: string, path: string, body?: unknown) => a.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const connect = async (kind: string, values: Record<string, string>, label = "") => (await (await call(app, "POST", "/api/connections", { kind, label, values })).json()).connection as any;
beforeEach(() => { process.env.SECRET = "t".repeat(40); db.exec("DELETE FROM connections; DELETE FROM indicators; DELETE FROM projects; DELETE FROM sites;"); const ctx = simCtx(); setConnectorContext(ctx); setCollectContext(ctx); });

test("Stripe : la devise du compte est détectée et gardée dans la connexion (réglage non secret)", async () => {
  const c = await connect("stripe", { key: KEY });
  assert.equal(connections("stripe")[0].config.currency, "eur");
  assert.equal(c.settings.currency, "eur");
  const created = await (await call(app, "POST", "/api/connections", { kind: "stripe", values: { key: KEY + "x" } })).json();
  assert.match(created.test.detail, /devise EUR/);
});

test("CA19 (serveur) : rattacher Stripe crée les indicateurs cochés avec config.connection_id, l'unité vient de la devise, le relevé a eu lieu", async () => {
  const c = await connect("stripe", { key: KEY });
  const p = saveProject(null, { name: "Boutique" })!;
  const r = await call(app, "POST", `/api/projects/${p.id}/sources`, { connection_id: c.id, items: [{ kpi: "revenue" }, { kpi: "mrr", label: "Revenu récurrent" }, { kpi: "active_subscriptions" }] });
  assert.equal(r.status, 201);
  const j = await r.json();
  assert.equal(j.created.length, 3); assert.deepEqual(j.skipped, []);
  const rows = db.prepare("SELECT label, unit, mode, source, config FROM indicators WHERE project_id = ? ORDER BY created_at").all(p.id) as any[];
  assert.deepEqual(rows.map((x) => [x.label, x.unit, x.mode, x.source]), [["CA net", "€", "daily", "stripe"], ["Revenu récurrent", "€", "total", "stripe"], ["Abonnements actifs", null, "total", "stripe"]]);
  for (const x of rows) { const cfg = JSON.parse(x.config); assert.equal(cfg.connection_id, c.id); assert.equal(cfg.env, undefined); }
  assert.equal(JSON.parse(rows[0].config).metric, "revenue");
  const m = db.prepare("SELECT COUNT(*) AS n FROM metrics WHERE indicator_id IN (SELECT id FROM indicators WHERE project_id = ?)").get(p.id) as any;
  assert.ok(m.n >= 3, "les relevés ont été faits au rattachement");
  // « Tester » d'un indicateur rattaché : valeur calculée par le connecteur
  const ind = saveIndicator(null, p.id, { label: "MRR test", mode: "total", source: "stripe", config: { metric: "mrr", connection_id: c.id } })!;
  assert.equal(await measure(ind), 29);
});

test("rattacher deux fois : les indicateurs identiques sont ignorés (« skipped »), rien n'est dupliqué", async () => {
  const c = await connect("stripe", { key: KEY });
  const p = saveProject(null, { name: "Doublons" })!;
  await call(app, "POST", `/api/projects/${p.id}/sources`, { connection_id: c.id, items: [{ kpi: "mrr" }] });
  const again = await (await call(app, "POST", `/api/projects/${p.id}/sources`, { connection_id: c.id, items: [{ kpi: "mrr" }, { kpi: "revenue" }] })).json();
  assert.equal(again.created.length, 1); assert.deepEqual(again.skipped, ["MRR"]);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM indicators WHERE project_id = ?").get(p.id) as any).n, 2);
});

test("validation : aucune écriture si un paramètre requis manque, KPI inconnu, connexion absente, projet absent", async () => {
  await connect("pagespeed", { key: "" });
  const ps = connections("pagespeed")[0]; const p = saveProject(null, { name: "Vitesse" })!;
  let r = await call(app, "POST", `/api/projects/${p.id}/sources`, { connection_id: ps.id, items: [{ kpi: "seo", params: { url: "https://exemple.com/" } }, { kpi: "lcp", params: {} }] });
  assert.equal(r.status, 400); assert.equal((await r.json()).error, "Champ requis : Adresse de la page");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM indicators WHERE project_id = ?").get(p.id) as any).n, 0, "le premier élément valide n'a pas été créé");
  assert.equal((await call(app, "POST", `/api/projects/${p.id}/sources`, { connection_id: ps.id, items: [{ kpi: "inconnu" }] })).status, 400);
  assert.equal((await call(app, "POST", `/api/projects/${p.id}/sources`, { connection_id: ps.id, items: [] })).status, 400);
  assert.equal((await call(app, "POST", `/api/projects/${p.id}/sources`, { connection_id: "nope", items: [{ kpi: "seo" }] })).status, 404);
  assert.equal((await call(app, "POST", `/api/projects/absent/sources`, { connection_id: ps.id, items: [{ kpi: "seo" }] })).status, 404);
});

test("chaque connecteur à KPI se rattache avec sa source et sa configuration (Play, Postgres, PageSpeed, API JSON)", async () => {
  const google = await connect("google", { json: GOOGLE_JSON, playBucket: "gs://pubsite_prod_rev_01234567890123456789" });
  const pg = await connect("postgres", { url: "postgres://searchtide_ro:" + "Fixt0reMotDePasseDemo@db.exemple.test:5432/produit" });
  const ps = await connect("pagespeed", { key: "" });
  const js = await connect("jsonapi", { origin: "https://api.exemple.test", token: "tok_" + "SOURCES0123456789abcdef" });
  const p = saveProject(null, { name: "Tout" })!;
  const attach = async (connection_id: string, items: unknown[]) => { const r = await call(app, "POST", `/api/projects/${p.id}/sources`, { connection_id, items }); assert.equal(r.status, 201, JSON.stringify(await r.clone().json())); return r.json(); };
  await attach(google.id, [{ kpi: "rating", params: { package: "com.exemple.app" } }, { kpi: "daily_installs", params: { package: "com.exemple.app" } }]);
  await attach(pg.id, [{ kpi: "sql_daily", label: "Inscriptions", params: { sql: "SELECT COUNT(*) FROM users WHERE created_at >= $1::date" } }, { kpi: "sql_total", label: "Utilisateurs", params: { sql: "SELECT COUNT(*) FROM users;" } }]);
  await attach(ps.id, [{ kpi: "performance", params: { url: "https://exemple.com/", strategy: "desktop" } }, { kpi: "lcp", params: { url: "https://exemple.com/" } }]);
  await attach(js.id, [{ kpi: "json_total", label: "Utilisateurs API", params: { url: "https://api.exemple.test/stats", path: "stats.users" } }]);
  const by = Object.fromEntries((db.prepare("SELECT label, unit, mode, source, config FROM indicators WHERE project_id = ?").all(p.id) as any[]).map((x) => [x.label, { ...x, config: JSON.parse(x.config) }]));
  assert.deepEqual(by["Note moyenne (Play)"].config, { package: "com.exemple.app", metric: "rating", connection_id: google.id });
  assert.equal(by["Installations par jour (Play)"].mode, "daily");
  assert.deepEqual([by["Inscriptions"].source, by["Inscriptions"].mode, by["Utilisateurs"].mode], ["pg", "daily", "total"]);
  assert.equal(by["Utilisateurs"].config.connection_id, pg.id);
  assert.deepEqual(by["Score de performance"].config, { url: "https://exemple.com/", metric: "performance", strategy: "desktop", connection_id: ps.id });
  assert.equal(by["LCP"].unit, "s"); assert.equal(by["LCP"].config.strategy, "mobile");
  assert.deepEqual(by["Utilisateurs API"].config, { url: "https://api.exemple.test/stats", path: "stats.users", connection_id: js.id }); assert.equal(by["Utilisateurs API"].source, "http");
  for (const x of Object.values(by) as any[]) assert.ok(x.config.connection_id);
  // les valeurs sont relevées par les connecteurs simulés
  const ok = (db.prepare("SELECT COUNT(*) AS n FROM indicators WHERE project_id = ? AND last_error IS NOT NULL").get(p.id) as any).n;
  assert.equal(ok, 0, "aucun relevé en erreur");
});

test("« Sources » : lignes par connexion avec leurs indicateurs, anciens indicateurs (.env), sites et propriété Search Console, base produit", async () => {
  const c = await connect("stripe", { key: KEY }, "Boutique");
  db.prepare("INSERT INTO sites (id, domain, name, gsc_property, created_at) VALUES ('s1', 'exemple.com', 'exemple.com', 'sc-domain:exemple.com', 0), ('s2', 'autre.fr', 'autre.fr', NULL, 0)").run();
  const p = saveProject(null, { name: "Mon projet", sites: ["exemple.com", "autre.fr"] })!;
  await call(app, "POST", `/api/projects/${p.id}/sources`, { connection_id: c.id, items: [{ kpi: "mrr" }, { kpi: "revenue" }] });
  process.env.SRC_TEST_KEY = "sk_" + "org_ancien";
  saveIndicator(null, p.id, { label: "Ancien", mode: "total", source: "stripe", config: { env: "SRC_TEST_KEY", metric: "mrr", account: "acct_1" } });
  saveIndicator(null, p.id, { label: "Saisie", mode: "total", source: "manual" });
  const s = await (await call(app, "GET", `/api/projects/${p.id}/sources`)).json();
  assert.equal(s.groups.length, 1); assert.equal(s.groups[0].connection.label, "Boutique"); assert.equal(s.groups[0].connection.name, "Stripe");
  assert.deepEqual(s.groups[0].indicators.map((i: any) => i.label).sort(), ["CA net", "MRR"]);
  assert.deepEqual(s.legacy.map((i: any) => [i.label, i.via]), [["Ancien", "env"]]);
  assert.deepEqual(s.sites.map((x: any) => [x.domain, x.gsc_property]), [["exemple.com", "sc-domain:exemple.com"], ["autre.fr", null]]);
  assert.equal(s.google, false); assert.equal(s.productDb, false);
  // la connexion retirée laisse une ligne « retirée » plutôt que de disparaître
  db.prepare("DELETE FROM connections WHERE id = ?").run(c.id);
  assert.equal((await (await call(app, "GET", `/api/projects/${p.id}/sources`)).json()).groups[0].connection, null);
});

test("droits : la section « Sources » et le rattachement sont réservés à la session administrateur", async () => {
  const p = saveProject(null, { name: "Droits" })!;
  assert.equal((await call(agent, "GET", `/api/projects/${p.id}/sources`)).status, 403);
  assert.equal((await call(agent, "POST", `/api/projects/${p.id}/sources`, { connection_id: "x", items: [{ kpi: "mrr" }] })).status, 403);
});

test("Search Console rattachée au SITE (sites.gsc_property), sans créer d'indicateur (le parcours par l'interface est testé en e2e)", async () => {
  await connect("google", { json: GOOGLE_JSON });
  db.prepare("INSERT INTO sites (id, domain, name, created_at) VALUES ('s9', 'exemple.com', 'exemple.com', 0)").run();
  const p = saveProject(null, { name: "SC", sites: ["exemple.com"] })!;
  const before = (db.prepare("SELECT COUNT(*) AS n FROM indicators").get() as any).n;
  db.prepare("UPDATE sites SET gsc_property = ? WHERE id = 's9'").run("sc-domain:exemple.com");
  const s = await (await call(app, "GET", `/api/projects/${p.id}/sources`)).json();
  assert.equal(s.sites[0].gsc_property, "sc-domain:exemple.com"); assert.equal(s.google, true);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM indicators").get() as any).n, before, "aucun indicateur créé");
});

test("catalogue : un projet avec analytics, Google et Stripe propose au moins 12 KPI", async () => {
  const { kpiCatalog } = await import("./sources.ts");
  const { setProjectModule } = await import("./modules/state.ts");
  await connect("stripe", { key: KEY }); await connect("google", { json: GOOGLE_JSON, playBucket: "gs://pubsite_prod_rev_00000000000000000001" });
  db.prepare("INSERT INTO sites (id, domain, name, gsc_property, created_at) VALUES ('cat', 'cat.fr', 'cat.fr', 'sc-domain:cat.fr', 0)").run();
  const p = saveProject(null, { name: "Cat", sites: ["cat.fr"] })!;
  setProjectModule(p.id, "stripe", true); setProjectModule(p.id, "google", true);
  const offers = kpiCatalog(p.id).flatMap((g) => g.offers).filter((o) => o.module !== "projets");
  assert.ok(offers.length >= 12, String(offers.length));
  assert.ok(offers.some((o) => o.module === "analytics" && o.kpi === "ai_visitors"));
});

test("catalogue : un KPI déjà suivi est marqué already, rien d'un module inactif sur le projet", async () => {
  const { kpiCatalog, addKpi } = await import("./sources.ts");
  const { setEnabled, setProjectModule } = await import("./modules/state.ts");
  const c = await connect("stripe", { key: KEY });
  const p = saveProject(null, { name: "Deja", sites: [] })!;
  setEnabled("stripe", true); setProjectModule(p.id, "stripe", false);
  assert.ok(!kpiCatalog(p.id).some((g) => g.module === "stripe"));
  setProjectModule(p.id, "stripe", true);
  await addKpi(p.id, { module: "stripe", connection_id: c.id, kpi: "mrr" });
  const mrr = kpiCatalog(p.id).find((g) => g.module === "stripe")!.offers.find((o) => o.kpi === "mrr")!;
  assert.equal(mrr.already, true);
});

test("catalogue : un KPI d'analytics se crée depuis le catalogue (visites venues des IA)", async () => {
  const { addKpi } = await import("./sources.ts");
  db.prepare("INSERT INTO sites (id, domain, name, created_at) VALUES ('ai', 'ia.fr', 'ia.fr', 0)").run();
  const ev = db.prepare("INSERT INTO events (site_id, ts, day, visitor, type, path, channel) VALUES ('ai', 0, '2026-11-09', ?, 'pageview', '/', ?)");
  ev.run("v1", "ai"); ev.run("v2", "ai"); ev.run("v3", "direct");
  const p = saveProject(null, { name: "IA", sites: ["ia.fr"] })!;
  const ind = await addKpi(p.id, { module: "analytics", connection_id: null, kpi: "ai_visitors", params: { domain: "ia.fr" } });
  assert.equal(ind.label, "Visites venues des IA · ia.fr");
  assert.equal(await measure(ind, "2026-11-09"), 2);
});
