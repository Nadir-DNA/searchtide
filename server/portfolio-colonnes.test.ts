// T21 : mesures comparables entre projets, catalogue de colonnes du Portefeuille et colonnes enregistrées.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { db, localDay } from "./db.ts";
import { markAdmin, markClient } from "./admin.ts";
import { MEASURES, getColumns, portfolio, registerPortfolio } from "./portfolio.ts";
import { lastDays } from "./stats.ts";
import { record, saveIndicator, saveProject } from "./projects.ts";
import { columnTotal } from "../web/src/portefeuille-total.ts";

const today = localDay();
const admin = new Hono(); admin.use("*", (c, n) => { markAdmin(c); return n(); }); registerPortfolio(admin);
const client = new Hono(); client.use("*", (c, n) => { markClient(c); return n(); }); registerPortfolio(client);
const call = (a: Hono, method: string, path: string, body?: unknown) => a.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
beforeEach(() => db.exec("DELETE FROM settings WHERE key = 'portfolio.columns'; DELETE FROM indicators; DELETE FROM projects; DELETE FROM metrics;"));

const stripe = (pid: string, metric: string, unit: string | null, value: number, previous?: number) => {
  const i = saveIndicator(null, pid, { label: metric, mode: "total", source: "stripe", unit, config: { metric, connection_id: "c" } })!;
  record(i.id, today, value);
  if (previous != null) record(i.id, new Date(Date.parse(today) - 10 * 86400000).toISOString().slice(0, 10), previous);   // avant la période de 7 jours
  return i;
};

test("mesures par projet : l'argent garde l'unité de sa devise, les notes se moyennent, les comptes s'additionnent", () => {
  const eur = saveProject(null, { name: "Europe" })!, usd = saveProject(null, { name: "Amérique" })!;
  stripe(eur.id, "mrr", "€", 540, 500); stripe(usd.id, "mrr", "$", 120);
  stripe(eur.id, "active_subscriptions", null, 12);
  for (const v of [80, 60]) { const i = saveIndicator(null, eur.id, { label: "perf", mode: "total", source: "pagespeed", config: { url: "https://exemple.com/", metric: "performance", connection_id: "x" } })!; record(i.id, today, v); }
  const p = portfolio(lastDays(7)).projects;
  const a = p.find((x) => x.id === eur.id)!, b = p.find((x) => x.id === usd.id)!;
  assert.deepEqual(a.measures.mrr, { value: 540, previous: 500, unit: "€" });
  assert.deepEqual(b.measures.mrr, { value: 120, previous: null, unit: "$" });
  assert.equal(a.measures.active_subscriptions.value, 12);
  assert.equal(a.measures["pagespeed:performance"].value, 70, "deux scores PageSpeed → moyenne");
  assert.equal(b.measures["pagespeed:performance"], undefined, "pas de source rattachée → pas de mesure");
  assert.equal(a.measures.visitors, undefined, "sans site, pas de visites");
});

test("catalogue de colonnes : seulement les mesures présentes dans au moins un projet, avec leur nature", () => {
  assert.deepEqual(portfolio(lastDays(7)).columns, []);
  const p = saveProject(null, { name: "Un projet" })!;
  stripe(p.id, "revenue", "€", 10); stripe(p.id, "mrr", "€", 5);
  const cols = portfolio(lastDays(7)).columns;
  assert.deepEqual(cols.map((c) => c.key), ["revenue", "mrr"]);
  assert.equal(cols[0].label, "CA net"); assert.equal(cols[0].kind, "money");
  for (const k of Object.keys(MEASURES)) assert.ok(MEASURES[k].label && MEASURES[k].kind, k);
});

test("colonnes enregistrées : par défaut aucune, enregistrement par l'administrateur, ordre conservé, validation", async () => {
  assert.equal(getColumns(), null);
  assert.deepEqual((await (await call(client, "GET", "/api/portfolio/columns")).json()).columns, null);
  assert.equal((await call(client, "PUT", "/api/portfolio/columns", { columns: ["mrr"] })).status, 403, "une clé d'API ne choisit pas les colonnes");
  assert.equal((await call(admin, "PUT", "/api/portfolio/columns", { columns: ["mrr", "inconnue"] })).status, 400);
  assert.equal((await call(admin, "PUT", "/api/portfolio/columns", { columns: "mrr" })).status, 400);
  const r = await call(admin, "PUT", "/api/portfolio/columns", { columns: ["mrr", "visitors", "revenue", "mrr"] });
  assert.deepEqual((await r.json()).columns, ["mrr", "visitors", "revenue"], "doublons retirés, ordre gardé");
  assert.deepEqual(getColumns(), ["mrr", "visitors", "revenue"]);
  assert.deepEqual((await (await call(client, "GET", "/api/portfolio/columns")).json()).columns, ["mrr", "visitors", "revenue"]);
  db.prepare("UPDATE settings SET value = '{pas du json' WHERE key = 'portfolio.columns'").run();
  assert.equal(getColumns(), null, "réglage illisible → comme si rien n'était choisi");
});

test("CA22 : la ligne Total additionne les comptes, jamais des devises différentes", () => {
  const eur = [{ value: 540, unit: "€" }, { value: 120, unit: "€" }];
  assert.deepEqual(columnTotal("money", eur), { value: 660, unit: "€", mixed: false });
  assert.deepEqual(columnTotal("money", [{ value: 540, unit: "€" }, { value: 120, unit: "$" }]), { value: null, unit: null, mixed: true }, "devises mélangées → aucune somme");
  assert.deepEqual(columnTotal("money", [{ value: 10, unit: null }, { value: 5, unit: "€" }]), { value: 15, unit: null, mixed: false }, "unité absente = euro par défaut");
  assert.deepEqual(columnTotal("count", [{ value: 12, unit: null }, { value: 3, unit: null }]), { value: 15, unit: null, mixed: false });
  assert.deepEqual(columnTotal("count", [{ value: null, unit: null }, { value: 3, unit: null }]), { value: 3, unit: null, mixed: false }, "une valeur absente ne compte pas");
  assert.deepEqual(columnTotal("count", [{ value: null, unit: null }]), { value: null, unit: null, mixed: false });
  assert.deepEqual(columnTotal("score", [{ value: 80, unit: null }, { value: 60, unit: null }]), { value: null, unit: null, mixed: false }, "un score ne se totalise pas");
  assert.deepEqual(columnTotal("position", [{ value: 4, unit: null }]), { value: null, unit: null, mixed: false });
});

test("nouveaux KPI : pipeline et relances viennent des contacts du projet, rien sans clé de contacts, taux de clic calculé", () => {
  const withKey = saveProject(null, { name: "Avec contacts", crm_key: "avec-contacts" })!, without = saveProject(null, { name: "Sans contacts" })!;
  const now = Date.now();
  db.prepare("INSERT INTO contacts (id, name, project, stage, value, next_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("k1", "A", "avec-contacts", "proposal", 1200, "2000-01-01", now, now);
  db.prepare("INSERT INTO contacts (id, name, project, stage, value, next_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("k2", "B", "avec-contacts", "won", 900, null, now, now);
  const p = portfolio(lastDays(7)).projects;
  const a = p.find((x) => x.id === withKey.id)!, b = p.find((x) => x.id === without.id)!;
  assert.equal(a.measures.pipeline.value, 1200, "seuls les contacts en négociation comptent, pas les gagnés");
  assert.equal(a.measures.pipeline.unit, "€");
  assert.equal(a.measures.followups.value, 1, "une relance en retard");
  assert.equal(b.measures.pipeline, undefined, "pas de clé de contacts → pas de faux zéro");
  assert.equal(b.measures.followups, undefined);
  assert.equal(b.measures.published, undefined, "aucune publication → pas de mesure");
  assert.equal(MEASURES.ctr.kind, "percent");
  db.exec("DELETE FROM contacts");
});
