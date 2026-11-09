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
