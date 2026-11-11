import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db.ts";
import "./business.ts";
import { saveProject } from "./projects.ts";
import { portfolio } from "./portfolio.ts";

test("portefeuille : totaux par projet, sites hors projet regroupés, alertes", () => {
  saveProject(null, { name: "Alpha", sites: ["alpha.test"], crm_key: "alpha" });
  const ins = db.prepare("INSERT INTO sites (id, domain, name, created_at) VALUES (?, ?, ?, 0)");
  ins.run("a", "alpha.test", "alpha.test"); ins.run("l", "seul.test", "seul.test");
  const ev = db.prepare("INSERT INTO events (site_id, ts, day, visitor, type, path, channel) VALUES (?, 0, ?, ?, 'pageview', '/', 'direct')");
  ev.run("a", "2026-11-08", "v1"); ev.run("a", "2026-11-09", "v1"); ev.run("a", "2026-11-09", "v2"); ev.run("l", "2026-11-09", "v9");
  db.prepare("INSERT INTO contacts (id, name, project, stage, tags, opt_out, created_at, updated_at) VALUES ('c1', 'Garage', 'alpha', 'new', '[]', 0, ?, 0)").run(Date.parse("2026-11-09T10:00:00Z"));
  const o = portfolio({ from: "2026-11-08", to: "2026-11-09" });
  const alpha = o.projects.find((p) => p.name === "Alpha")!;
  assert.equal(alpha.visitors, 3); // visiteurs uniques de chaque jour, additionnés
  assert.equal(alpha.leads, 1); assert.equal(alpha.open, 1);
  assert.equal(alpha.series["2026-11-09"], 2);
  const loose = o.projects.find((p) => p.name === "Autres sites")!;
  assert.deepEqual(loose.sites, ["seul.test"]);
  assert.equal(o.totals.visitors, 4);
  assert.equal(o.daily.find((d) => d.day === "2026-11-09")![alpha.id], 2);
});

test("portefeuille : sans source, chiffre d'affaires, clics et contacts valent null et non 0", async () => {
  const { setEnabled } = await import("./modules/state.ts");
  setEnabled("crm", false); setEnabled("google", false); setEnabled("stripe", false);
  const t = portfolio({ from: "2026-11-08", to: "2026-11-09" }).totals;
  assert.equal(t.revenue, null); assert.equal(t.mrr, null); assert.equal(t.clicks, null); assert.equal(t.leads, null);
  setEnabled("crm", true);
  assert.equal(typeof portfolio({ from: "2026-11-08", to: "2026-11-09" }).totals.leads, "number");
});

test("portefeuille : les indicateurs d'un module retiré du projet disparaissent des projets", async () => {
  const { setEnabled, setProjectModule } = await import("./modules/state.ts");
  const { saveIndicator } = await import("./projects.ts");
  const p = saveProject(null, { name: "Beta", sites: [] })!;
  saveIndicator(null, p.id, { label: "MRR", mode: "total", source: "stripe", config: { metric: "mrr", env: "STRIPE_B" } });
  setEnabled("stripe", true); setProjectModule(p.id, "stripe", false);
  assert.equal(portfolio({ from: "2026-11-08", to: "2026-11-09" }).projects.find((x) => x.id === p.id)!.kpis.length, 0);
  setProjectModule(p.id, "stripe", true);
  assert.equal(portfolio({ from: "2026-11-08", to: "2026-11-09" }).projects.find((x) => x.id === p.id)!.kpis.length, 1);
});
