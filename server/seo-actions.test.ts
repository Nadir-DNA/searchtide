// B1 : plan d'action SEO dans « À traiter » — erreurs d'audit, baisse de clics, titre à réécrire, pages non indexées.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db.ts";
import { seoActions } from "./today.ts";

test("actions classées : erreurs d'abord, puis baisse, titre, indexation ; quatre au plus, liens vers l'écran utile", () => {
  const pid = `p-${Date.now()}`, sid = `s-${Date.now()}`, d = "actions.test";
  db.prepare("INSERT INTO sites (id, domain, name, created_at) VALUES (?, ?, ?, ?)").run(sid, d, d, Date.now());
  db.prepare("INSERT INTO projects (id, name, sites, created_at) VALUES (?, ?, ?, 0)").run(pid, "Boutique", JSON.stringify([d]));
  db.prepare("INSERT INTO project_modules (project_id, module_id, enabled, settings) VALUES (?, 'google', 1, ?)").run(pid, JSON.stringify({ gsc_property: { [d]: `sc-domain:${d}` } }));
  // Audit : deux pages en erreur
  db.prepare("INSERT INTO audit_runs (id, site_id, started_at, finished_at, pages, state) VALUES ('run-a', ?, ?, ?, 10, 'done')").run(sid, Date.now(), Date.now());
  for (const u of ["/x", "/y"]) db.prepare("INSERT INTO audit_issues (run_id, type, url) VALUES ('run-a', 'http_error', ?)").run(`https://${d}${u}`);
  // Search Console : une page qui perd des clics, une page peu cliquée pour sa position
  const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  const row = (n: number, page: string, clicks: number, impressions: number, position: number) =>
    db.prepare("INSERT INTO gsc_rows (site_id, day, query, page, clicks, impressions, position) VALUES (?, ?, '', ?, ?, ?, ?)").run(sid, day(n), `https://${d}${page}`, clicks, impressions, position);
  row(40, "/guide", 60, 600, 3); row(5, "/guide", 10, 600, 6);
  row(5, "/tarifs", 1, 800, 2);
  // Indexation : une page refusée
  db.prepare("INSERT INTO indexing_pages (site_id, url, verdict, coverage) VALUES (?, ?, 'NEUTRAL', 'Explorée, non indexée')").run(sid, `https://${d}/z`);

  const items = seoActions(db.prepare("SELECT * FROM projects WHERE id = ?").get(pid) as any);
  assert.equal(items.length, 4);
  assert.match(items[0].text, /pages en erreur.*2 pages/);
  assert.deepEqual(items[0].to, { site: d, tab: "outils" });
  assert.match(items[1].text, /\/guide perd 50 clics/);
  assert.match(items[2].text, /réécrire le titre de \/tarifs/);
  assert.match(items[3].text, /1 page non indexée par Google/);
  assert.ok(items.every((i) => i.project_id === pid && i.kind === "action"));
});
