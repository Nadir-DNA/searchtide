import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db.ts";
import { getProject, indicatorView, measure, record, saveIndicator, saveProject } from "./projects.ts";

const p = saveProject(null, { name: "Projet test", sites: ["proj.test"], crm_key: "test" })!;

test("indicateur journalier : somme sur la période et période précédente", () => {
  const ind = saveIndicator(null, p.id, { label: "Inscriptions", mode: "daily", source: "manual" })!;
  record(ind.id, "2026-11-08", 3); record(ind.id, "2026-11-09", 2); record(ind.id, "2026-11-06", 4);
  const v = indicatorView(ind, { from: "2026-11-08", to: "2026-11-09" });
  assert.equal(v.value, 5); assert.equal(v.previous, 4);
  assert.deepEqual(v.series.map((s) => s.value), [3, 2]);
});

test("niveau : dernière valeur connue, comparée à celle d'avant la période", () => {
  const ind = saveIndicator(null, p.id, { label: "Clients actifs", mode: "total", source: "manual" })!;
  record(ind.id, "2026-10-01", 10); record(ind.id, "2026-11-05", 14);
  const v = indicatorView(ind, { from: "2026-11-01", to: "2026-11-09" });
  assert.equal(v.value, 14); assert.equal(v.previous, 10);
});

test("site suivi : série calculée depuis les visites", () => {
  db.prepare("INSERT INTO sites (id, domain, name, created_at) VALUES ('ps', 'proj.test', 'proj.test', 0)").run();
  db.prepare("INSERT INTO events (site_id, ts, day, visitor, type, path, channel) VALUES ('ps', 0, '2026-11-09', 'a', 'pageview', '/', 'direct'), ('ps', 0, '2026-11-09', 'b', 'pageview', '/', 'direct')").run();
  const ind = saveIndicator(null, p.id, { label: "Visiteurs", mode: "daily", source: "site", config: { domain: "proj.test", metric: "visitors" } })!;
  assert.equal(indicatorView(ind, { from: "2026-11-09", to: "2026-11-09" }).value, 2);
});

test("validation et garde-fous des connecteurs", async () => {
  assert.throws(() => saveIndicator(null, p.id, { label: "x", mode: "daily", source: "pg", config: { env: "mauvais nom", sql: "select 1" } }));
  assert.throws(() => saveIndicator(null, p.id, { label: "x", mode: "daily", source: "stripe", config: { env: "STRIPE_X", metric: "inconnu" } }));
  await assert.rejects(measure({ source: "pg", mode: "total", config: { env: "ABSENTE_DB_URL", sql: "select 1" } }), /ABSENTE_DB_URL absente/);
  process.env.FAUSSE_DB_URL = "postgres://x@127.0.0.1:1/x";
  await assert.rejects(measure({ source: "pg", mode: "total", config: { env: "FAUSSE_DB_URL", sql: "delete from t" } }), /SELECT/);
});

test("minuit à Paris, heure d'hiver et d'été", async () => {
  const { parisMidnight } = await import("./projects.ts");
  assert.equal(parisMidnight("2026-11-09"), Date.parse("2026-11-08T23:00:00Z") / 1000);
  assert.equal(parisMidnight("2026-07-01"), Date.parse("2026-06-30T22:00:00Z") / 1000);
});

test("objectif du mois : avancement et projection au rythme actuel", async () => {
  const { goalProgress } = await import("./projects.ts");
  const ind = saveIndicator(null, p.id, { label: "Ventes", mode: "daily", source: "manual", goal: 30, goal_period: "month" })!;
  record(ind.id, "2026-11-01", 4); record(ind.id, "2026-11-05", 6);
  const g = goalProgress(ind, new Date("2026-11-10T10:00:00Z"))!;
  assert.equal(g.done, 10); assert.equal(g.elapsed, 10); assert.equal(g.total, 30);
  assert.equal(g.projection, 30); assert.equal(g.pct, 33.3);
});

test("entonnoir : taux de passage entre étapes", async () => {
  const { listProjects } = await import("./projects.ts");
  const q = saveProject(null, { name: "Entonnoir" })!;
  const a = saveIndicator(null, q.id, { label: "Visites", mode: "daily", source: "manual" })!;
  const b = saveIndicator(null, q.id, { label: "Inscrits", mode: "daily", source: "manual" })!;
  record(a.id, "2026-11-09", 200); record(b.id, "2026-11-09", 10);
  saveProject(q.id, { funnel: [a.id, b.id] });
  const f = listProjects({ from: "2026-11-09", to: "2026-11-09" }).find((x) => x.id === q.id)!.funnel;
  assert.deepEqual(f.map((s: any) => s.rate), [null, 5]);
});

test("publication : code de campagne et visites amenées", async () => {
  const { savePublication, listPublications } = await import("./business.ts");
  const pub = savePublication(null, { day: "2026-11-12", title: "Vidéo Été !" }) as any;
  assert.equal(pub.campaign, "video-ete-1112");
  db.prepare("INSERT INTO events (site_id, ts, day, visitor, type, path, channel, utm_campaign) VALUES ('ps', 0, '2026-11-12', 'z', 'pageview', '/', 'social', 'video-ete-1112')").run();
  assert.equal((listPublications({ from: "2026-11-12", to: "2026-11-12" }) as any[]).find((x) => x.id === pub.id).visits, 1);
});

test("connecteurs PageSpeed et Google Play : configuration validée, accès manquant signalé", async () => {
  assert.throws(() => saveIndicator(null, p.id, { label: "x", mode: "total", source: "play", config: { package: "Pas Valide", metric: "rating" } }));
  delete process.env.PAGESPEED_KEY;
  await assert.rejects(measure({ source: "pagespeed", mode: "total", config: { url: "https://exemple.fr/", metric: "performance" } }), /PAGESPEED_KEY absente/);
  delete process.env.PLAY_BUCKET;
  await assert.rejects(measure({ source: "play", mode: "total", config: { package: "com.exemple.apps", metric: "rating" } }), /PLAY_BUCKET absente/);
});

test("Stripe avec une clé d'organisation : compte visé dans Stripe-Context", async () => {
  process.env.TEST_STRIPE_ORG = "sk_" + "org_test";
  const seen: Record<string, string>[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_u: string, init: RequestInit) => { seen.push(init.headers as Record<string, string>); return new Response(JSON.stringify({ data: [{ items: { data: [] } }], has_more: false })); }) as typeof fetch;
  try {
    const ind = { source: "stripe", mode: "total", config: { env: "TEST_STRIPE_ORG", metric: "active_subscriptions", account: "acct_123" } };
    assert.equal(await measure(ind), 1);
    assert.equal(seen[0]["Stripe-Context"], "acct_123");
    assert.ok(seen[0]["Stripe-Version"]);
    await assert.rejects(measure({ ...ind, config: { env: "TEST_STRIPE_ORG", metric: "mrr" } }), /acct_/);
  } finally { globalThis.fetch = real; }
});

test("revenu mensuel : remises déduites, prix annuel ramené au mois", async () => {
  const { monthlyNet } = await import("./projects.ts");
  const item = (u: number, interval: string) => ({ items: { data: [{ price: { unit_amount: u, recurring: { interval } }, quantity: 1 }] } });
  assert.equal(monthlyNet({ ...item(2900, "month"), discounts: [{ coupon: { percent_off: 100 } }] }), 0);
  assert.equal(monthlyNet({ ...item(12000, "year"), discounts: [] }), 1000);
  assert.equal(monthlyNet({ ...item(2900, "month"), discounts: [{ coupon: { amount_off: 900 } }] }), 2000);
});

test("formule : taux de conversion jour par jour, division par zéro absente, valeur sur la période", async () => {
  const { formulaSeries } = await import("./projects.ts");
  const p = saveProject(null, { name: "Conv" })!;
  const ins = saveIndicator(null, p.id, { label: "Inscriptions", mode: "daily", source: "manual", config: {} })!;
  const vis = saveIndicator(null, p.id, { label: "Visites", mode: "daily", source: "manual", config: {} })!;
  [["2026-11-01", 2, 100], ["2026-11-02", 0, 0], ["2026-11-03", 3, 50]].forEach(([d, a, b]) => { record(ins.id, d as string, a as number); record(vis.id, d as string, b as number); });
  const cfg = { terms: [{ indicator: ins.id, op: "+" as const }, { indicator: vis.id, op: "/" as const }], scale: 100 };
  const r = { from: "2026-11-01", to: "2026-11-03" };
  assert.deepEqual(Object.values(formulaSeries(cfg, p.id, r)), [2, null, 6]);
  const f = saveIndicator(null, p.id, { label: "Conversion", unit: "%", mode: "total", source: "formula", config: cfg })!;
  const view = getProject(p.id, r)!.indicators.find((i: any) => i.id === f.id);
  assert.equal(view.value, 3.3333); // 5 inscriptions / 150 visites sur la période
  assert.deepEqual(view.series.map((x: any) => x.value), [2, null, 6]);
});

test("formule : opérande supprimée → null et message", async () => {
  const p = saveProject(null, { name: "Orph" })!;
  const a = saveIndicator(null, p.id, { label: "A", mode: "daily", source: "manual", config: {} })!;
  const b = saveIndicator(null, p.id, { label: "B", mode: "daily", source: "manual", config: {} })!;
  const f = saveIndicator(null, p.id, { label: "A/B", mode: "total", source: "formula", config: { terms: [{ indicator: a.id, op: "+" }, { indicator: b.id, op: "/" }] } })!;
  db.prepare("DELETE FROM indicators WHERE id = ?").run(b.id);
  const view = getProject(p.id, { from: "2026-11-01", to: "2026-11-03" })!.indicators.find((i: any) => i.id === f.id);
  assert.equal(view.value, null);
  assert.equal(view.last_error, `Indicateur « ${b.id} » introuvable`);
});

test("formule : une formule ne peut pas en citer une autre, ni un indicateur d'un autre projet", () => {
  const p = saveProject(null, { name: "Nest" })!, q = saveProject(null, { name: "Autre" })!;
  const a = saveIndicator(null, p.id, { label: "A", mode: "daily", source: "manual", config: {} })!;
  const x = saveIndicator(null, q.id, { label: "X", mode: "daily", source: "manual", config: {} })!;
  const f = saveIndicator(null, p.id, { label: "F", mode: "total", source: "formula", config: { terms: [{ indicator: a.id, op: "+" }, { indicator: a.id, op: "*" }] } })!;
  assert.throws(() => saveIndicator(null, p.id, { label: "G", mode: "total", source: "formula", config: { terms: [{ indicator: f.id, op: "+" }, { indicator: a.id, op: "+" }] } }), /formule/);
  assert.throws(() => saveIndicator(null, p.id, { label: "H", mode: "total", source: "formula", config: { terms: [{ indicator: a.id, op: "+" }, { indicator: x.id, op: "+" }] } }), /autre projet/);
});
