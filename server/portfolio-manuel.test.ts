// B1 / CA34 : les saisies manuelles marquées « CA » ou « contacts » entrent dans le Portefeuille,
// jamais additionnées à Stripe, et la cellule est marquée « saisi ».
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, localDay } from "./db.ts";
import { portfolio } from "./portfolio.ts";
import { lastDays } from "./stats.ts";
import { record, saveIndicator, saveProject } from "./projects.ts";
import { columnTotal } from "../web/src/portefeuille-total.ts";

const today = localDay();
const metric = (pid: string, role: "revenue" | "contacts", value: number, unit: string | null = "€") => {
  const i = saveIndicator(null, pid, { label: role, mode: "total", source: "manual", unit, config: { role } })!;
  record(i.id, today, value);
  return i;
};
beforeEach(() => db.exec("DELETE FROM indicators; DELETE FROM projects;"));

test("B1 : CA et contacts saisis apparaissent dans le Portefeuille, marqués « saisi », et comptent dans le total", () => {
  const p = saveProject(null, { name: "Sans Stripe" })!;
  metric(p.id, "revenue", 147, "€");
  metric(p.id, "contacts", 92, null);
  const row = portfolio(lastDays(7)).projects.find((x) => x.id === p.id)!;
  assert.deepEqual(row.measures.revenue, { value: 147, previous: null, unit: "€", manual: true });
  assert.deepEqual(row.measures.leads, { value: 92, previous: null, unit: null, manual: true });
  const cols = portfolio(lastDays(7)).columns.map((c) => c.key);
  assert.ok(cols.includes("revenue") && cols.includes("leads"));
  assert.deepEqual(columnTotal("money", [row.measures.revenue]), { value: 147, unit: "€", mixed: false });
});

test("B1 : avec Stripe et une saisie, seule la valeur Stripe compte ; sans rôle, rien ne change", () => {
  const p = saveProject(null, { name: "Avec Stripe" })!;
  const s = saveIndicator(null, p.id, { label: "CA Stripe", mode: "total", source: "stripe", unit: "€", config: { metric: "revenue", connection_id: "c" } })!;
  record(s.id, today, 500);
  metric(p.id, "revenue", 147, "€");
  const free = saveIndicator(null, p.id, { label: "Libre", mode: "total", source: "manual", unit: "€", config: {} })!;
  record(free.id, today, 999);
  const row = portfolio(lastDays(7)).projects.find((x) => x.id === p.id)!;
  assert.equal(row.measures.revenue.value, 500);
  assert.equal(row.measures.revenue.manual, undefined, "valeur Stripe, pas une saisie");
});

test("B1 : deux devises restent séparées dans le total", () => {
  const eur = saveProject(null, { name: "Europe" })!, usd = saveProject(null, { name: "Amérique" })!;
  metric(eur.id, "revenue", 147, "€");
  metric(usd.id, "revenue", 92, "$");
  const r = portfolio(lastDays(7)).projects;
  const a = r.find((x) => x.id === eur.id)!, b = r.find((x) => x.id === usd.id)!;
  assert.deepEqual(columnTotal("money", [a.measures.revenue, b.measures.revenue]), { value: null, unit: null, mixed: true });
});

test("CA34 bis : Stripe ne prime que sur la mesure qu'il fournit (MRR seul ne masque pas le CA saisi)", () => {
  const p = saveProject(null, { name: "MRR seul" })!;
  const mrr = saveIndicator(null, p.id, { label: "MRR", mode: "total", source: "stripe", unit: "€", config: { metric: "mrr", connection_id: "c" } })!;
  record(mrr.id, today, 29);
  metric(p.id, "revenue", 147, "€");
  metric(p.id, "contacts", 92, null);
  const row = portfolio(lastDays(7)).projects.find((x) => x.id === p.id)!;
  assert.deepEqual(row.measures.revenue, { value: 147, previous: null, unit: "€", manual: true }, "le CA saisi reste visible");
  assert.deepEqual(row.measures.leads, { value: 92, previous: null, unit: null, manual: true }, "les contacts saisis restent visibles");
  assert.equal(row.measures.mrr.value, 29);
});

test("M2 / CA34 bis : un indicateur Stripe revenue sans valeur ne masque pas la saisie « CA »", () => {
  const p = saveProject(null, { name: "Revenue vide" })!;
  saveIndicator(null, p.id, { label: "CA Stripe", mode: "total", source: "stripe", unit: "€", config: { metric: "revenue", connection_id: "c" } });
  metric(p.id, "revenue", 147, "€");
  const row = portfolio(lastDays(7)).projects.find((x) => x.id === p.id)!;
  assert.deepEqual(row.measures.revenue, { value: 147, previous: null, unit: "€", manual: true });
});
