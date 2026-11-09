// T20, CA21 : score de santé par projet (04-produit §6). Cas fixés : couverture 50 % avec action applicable / 56 % sans, période précédente à 0,
// poids modifiés (renormalisation), seuils, poids enregistrés, aperçu, branchement sur les données du portefeuille.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { db, localDay } from "./db.ts";
import { markAdmin, markClient } from "./admin.ts";
import { DEFAULT_WEIGHTS, computeHealth, getWeights, parseWeights, setWeights, type Inputs, type Weights } from "./health.ts";
import { portfolio, registerPortfolio } from "./portfolio.ts";
import { lastDays } from "./stats.ts";
import { saveIndicator, saveProject } from "./projects.ts";

const base = (over: Partial<Inputs> = {}): Inputs => ({
  trend: { visits: { now: 200, before: 100 } },         // +100 % → 100
  goals: { total: 0, reached: 0 },
  reliability: { items: 4, errors: 2 },                 // 50
  conversion: null, action: null, ...over,
});
const part = (h: ReturnType<typeof computeHealth>, k: string) => h.parts.find((p) => p.key === k)!;

test("CA21 : projet sans objectif ni entonnoir, poids par défaut — couverture 50 ÷ 100 = 50 % avec le CRM, 50 ÷ 90 ≈ 56 % sans (Action non applicable)", () => {
  const crm = computeHealth(base(), DEFAULT_WEIGHTS, { crm: true });
  assert.equal(crm.coverage, 50); assert.equal(crm.score, 80);       // (30×100 + 20×50) ÷ 50
  assert.deepEqual(crm.missing, ["Objectifs", "Conversion", "Action"]);
  const pub = computeHealth(base(), DEFAULT_WEIGHTS, { crm: false });
  assert.equal(pub.coverage, 56); assert.equal(pub.score, 80);       // 50 ÷ 90 = 55,6 %
  assert.deepEqual(pub.missing, ["Objectifs", "Conversion"]);
  assert.equal(part(pub, "action").applicable, false); assert.equal(part(pub, "action").why, "Non applicable sur cette instance");
});

test("CA21 : période précédente à 0 → la tendance est exclue du score (pas de division par zéro)", () => {
  const h = computeHealth(base({ trend: { visits: { now: 50, before: 0 }, clicks: { now: 10, before: 0 }, mrr: { now: 29, before: null } } }), DEFAULT_WEIGHTS, { crm: false });
  assert.equal(part(h, "trend").measured, false); assert.match(part(h, "trend").why!, /période précédente supérieure à zéro/);
  assert.equal(h.score, 50);                                           // seule la fiabilité est mesurée
  assert.equal(h.coverage, 22);                                        // 20 ÷ 90
  assert.equal(h.partial, true);
  // une mesure utilisable suffit : les autres (précédent 0) sont ignorées, la moyenne ne porte que sur elle
  const one = computeHealth(base({ trend: { visits: { now: 150, before: 100 }, clicks: { now: 5, before: 0 } } }), DEFAULT_WEIGHTS, { crm: false });
  assert.equal(part(one, "trend").value, 75);
});

test("CA21 : poids modifiés → score renormalisé sur les seules composantes mesurées ; somme libre ; tout à zéro → pas de score", () => {
  const custom: Weights = { trend: 10, goals: 0, reliability: 40, conversion: 0, action: 0 };
  const h = computeHealth(base(), custom, { crm: true });
  assert.equal(h.score, 60);                                           // (10×100 + 40×50) ÷ 50
  assert.equal(h.coverage, 100);                                       // poids applicables = 50, tous mesurés
  assert.equal(computeHealth(base(), { ...DEFAULT_WEIGHTS, trend: 100, reliability: 100 }, { crm: true }).score, 75);   // somme ≠ 100 : sans importance
  const none = computeHealth(base(), { trend: 0, goals: 0, reliability: 0, conversion: 0, action: 0 }, { crm: true });
  assert.equal(none.score, null); assert.equal(none.tone, "none"); assert.equal(none.coverage, 0);
});

test("composantes : objectifs, conversion, action, tendance moyenne des mesures, bornes ±100 %", () => {
  const h = computeHealth({
    trend: { visits: { now: 300, before: 100 }, clicks: { now: 0, before: 100 }, revenue: { now: 90, before: 100 } },   // 100, 0, 45 → moyenne 48,33
    goals: { total: 3, reached: 2 },
    reliability: { items: 0, errors: 0 },                               // rien à surveiller = 100
    conversion: { steps: 3, now: 0.05, before: 0.1 },                   // −50 % → 25
    action: { late: 3 },                                                // 100 − 60 = 40
  }, DEFAULT_WEIGHTS, { crm: true });
  assert.equal(part(h, "trend").value!.toFixed(2), "48.33"); assert.equal(part(h, "goals").value!.toFixed(1), "66.7");
  assert.equal(part(h, "reliability").value, 100); assert.equal(part(h, "conversion").value, 25); assert.equal(part(h, "action").value, 40);
  assert.equal(h.coverage, 100); assert.equal(h.missing.length, 0);
  assert.equal(h.score, Math.round((30 * 48.3333 + 25 * 66.6667 + 20 * 100 + 15 * 25 + 10 * 40) / 100));
  assert.equal(part(computeHealth(base({ action: { late: 9 } }), DEFAULT_WEIGHTS, { crm: true }), "action").value, 0, "jamais négatif");
  assert.equal(part(computeHealth(base({ conversion: { steps: 2, now: 0.3, before: 0.1 } }), DEFAULT_WEIGHTS), "conversion").value, 100, "plafonné à +100 %");
  assert.equal(part(computeHealth(base({ conversion: { steps: 1, now: 0.3, before: 0.1 } }), DEFAULT_WEIGHTS), "conversion").measured, false, "moins de 2 étapes");
  assert.equal(part(computeHealth(base({ conversion: { steps: 2, now: 0.3, before: 0 } }), DEFAULT_WEIGHTS), "conversion").measured, false, "conversion précédente à 0");
  assert.equal(part(computeHealth(base({ action: { late: 2 } }), DEFAULT_WEIGHTS, { crm: false }), "action").measured, false, "sans CRM, Action n'est pas mesurée même si on la fournit");
});

test("seuils d'affichage : ≥ 70 positif, 40 à 69 avertissement, < 40 négatif ; couverture < 50 % = score partiel", () => {
  const s = (errors: number, items: number) => computeHealth({ trend: {}, goals: { total: 0, reached: 0 }, reliability: { items, errors }, conversion: null, action: null }, DEFAULT_WEIGHTS, { crm: false });
  assert.deepEqual([s(3, 10).score, s(3, 10).tone], [70, "positive"]);
  assert.deepEqual([s(31, 100).score, s(31, 100).tone], [69, "warn"]);
  assert.deepEqual([s(6, 10).score, s(6, 10).tone], [40, "warn"]);
  assert.deepEqual([s(61, 100).score, s(61, 100).tone], [39, "negative"]);
  assert.equal(s(0, 5).coverage, 22); assert.equal(s(0, 5).partial, true);
  assert.deepEqual(s(0, 5).missing, ["Tendance", "Objectifs", "Conversion"]);
});

beforeEach(() => { db.exec("DELETE FROM settings WHERE key = 'health.weights'"); delete process.env.DEMO; });

test("poids enregistrés : valeurs par défaut, enregistrement, validation de 0 à 100", () => {
  assert.deepEqual(getWeights(), DEFAULT_WEIGHTS);
  const w = parseWeights({ trend: "10", goals: "0", reliability: 40, conversion: "7,5", action: 0 });
  assert.deepEqual(w, { trend: 10, goals: 0, reliability: 40, conversion: 7.5, action: 0 });
  setWeights(w as Weights); assert.deepEqual(getWeights(), w);
  for (const bad of [{ ...DEFAULT_WEIGHTS, trend: -1 }, { ...DEFAULT_WEIGHTS, goals: 101 }, { ...DEFAULT_WEIGHTS, action: "abc" }, { trend: 1, goals: 1, reliability: 1, conversion: 1 }, null, "x"])
    assert.equal(typeof parseWeights(bad), "string", JSON.stringify(bad));
  db.prepare("UPDATE settings SET value = '{broken' WHERE key = 'health.weights'").run();
  assert.deepEqual(getWeights(), DEFAULT_WEIGHTS, "un réglage illisible retombe sur les valeurs par défaut");
});

// ───── Branchement sur les données réelles du portefeuille ─────
const dayOffset = (n: number) => new Date(Date.parse(localDay()) - n * 86400000).toISOString().slice(0, 10);
function seedProject(name: string, domain: string, now: number, before: number) {
  db.prepare("INSERT OR IGNORE INTO sites (id, domain, name, created_at) VALUES (?, ?, ?, 0)").run("s-" + domain, domain, domain);
  const ev = db.prepare("INSERT INTO events (site_id, ts, day, visitor, type, path, channel) VALUES (?, 0, ?, ?, 'pageview', '/', 'direct')");
  for (let i = 0; i < now; i++) ev.run("s-" + domain, dayOffset(i % 6), `v${i}`);               // 7 derniers jours (le plus récent = aujourd'hui)
  for (let i = 0; i < before; i++) ev.run("s-" + domain, dayOffset(7 + (i % 6)), `w${i}`);      // les 7 jours d'avant
  return saveProject(null, { name, sites: [domain] })!;
}

test("CA21 (données réelles) : tendance des visites + fiabilité → score, couverture 50 % avec le CRM / 56 % en démonstration ; poids modifiés → score renormalisé", () => {
  const p = seedProject("Santé", "sante.test", 12, 6);                                          // visites ×2 → tendance 100
  const bad = saveIndicator(null, p.id, { label: "Saisie en panne", mode: "total", source: "manual" })!;
  db.prepare("UPDATE indicators SET last_error = 'panne' WHERE id = ?").run(bad.id);           // 1 indicateur + 1 site = 2 éléments, 1 en erreur → fiabilité 50
  const r = lastDays(7);
  let row = portfolio(r).projects.find((x) => x.id === p.id)!;
  assert.equal(row.health!.coverage, 50); assert.equal(row.health!.score, 80); assert.equal(row.health!.tone, "positive");
  assert.deepEqual(row.health!.missing, ["Objectifs", "Conversion", "Action"]);
  process.env.DEMO = "1";                                                                       // sans CRM : Action non applicable
  row = portfolio(r).projects.find((x) => x.id === p.id)!;
  assert.equal(row.health!.coverage, 56); assert.equal(row.health!.score, 80);
  delete process.env.DEMO;
  row = portfolio(r, { trend: 10, goals: 0, reliability: 40, conversion: 0, action: 0 }).projects.find((x) => x.id === p.id)!;
  assert.equal(row.health!.score, 60);
  // la ligne « Autres sites » n'est pas un projet : pas de score
  seedProject("Autre", "autre-sante.test", 1, 1); db.prepare("INSERT OR IGNORE INTO sites (id, domain, name, created_at) VALUES ('orphan', 'orphelin.test', 'orphelin.test', 0)").run();
  assert.equal(portfolio(r).projects.find((x) => x.id === "")!.health, null);
});

test("période précédente sans visite → tendance non mesurée dans le portefeuille réel (score = fiabilité seule)", () => {
  const p = seedProject("Nouveau", "nouveau.test", 5, 0);
  const h = portfolio(lastDays(7)).projects.find((x) => x.id === p.id)!.health!;
  assert.equal(h.parts.find((x) => x.key === "trend")!.measured, false);
  assert.equal(h.coverage, 20); assert.equal(h.partial, true);
});

test("API : poids lisibles par tous, modifiables par l'administrateur seulement ; aperçu avec des poids non enregistrés", async () => {
  const admin = new Hono(); admin.use("*", (c, n) => { markAdmin(c); return n(); }); registerPortfolio(admin);
  const client = new Hono(); client.use("*", (c, n) => { markClient(c); return n(); }); registerPortfolio(client);
  const call = (a: Hono, method: string, path: string, body?: unknown) => a.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const p = seedProject("Aperçu", "apercu.test", 12, 6);
  saveIndicator(null, p.id, { label: "Saisie", mode: "total", source: "manual" });
  assert.deepEqual((await (await call(client, "GET", "/api/health/weights")).json()).weights, DEFAULT_WEIGHTS);
  assert.equal((await call(client, "PUT", "/api/health/weights", { weights: DEFAULT_WEIGHTS })).status, 403);
  assert.equal((await call(admin, "PUT", "/api/health/weights", { weights: { ...DEFAULT_WEIGHTS, trend: 500 } })).status, 400);
  const prev = await (await call(client, "POST", "/api/health/preview?days=7", { weights: { trend: 10, goals: 0, reliability: 40, conversion: 0, action: 0 } })).json();
  const mine = prev.projects.find((x: any) => x.id === p.id);
  assert.equal(mine.score, 100);                       // tendance 100 (visites ×2) et fiabilité 100 : quels que soient les poids, 100
  assert.deepEqual(getWeights(), DEFAULT_WEIGHTS, "l'aperçu n'enregistre rien");
  const saved = await call(admin, "PUT", "/api/health/weights", { weights: { trend: 10, goals: 0, reliability: 40, conversion: 0, action: 0 } });
  assert.equal(saved.status, 200); assert.equal(getWeights().trend, 10);
  assert.equal((await (await call(admin, "GET", "/api/portfolio?days=7")).json()).projects.find((x: any) => x.id === p.id).health.coverage, 100);
});
