import { test } from "node:test";
import assert from "node:assert/strict";
import { db, localDay } from "./db.ts";
import "./business.ts";
import { saveMilestone, saveProject } from "./projects.ts";
import { setEnabled, setProjectModule } from "./modules/state.ts";
import { alertKey, setTodayState, today } from "./today.ts";

const at = (n: number) => localDay(new Date(Date.now() + n * 86400000));

test("aujourd'hui : un élément ignoré ne revient pas, un report revient demain, un « fait » revient le lendemain", () => {
  const p = saveProject(null, { name: "Fil" })!;
  saveMilestone({ project_id: p.id, day: at(2), label: "Ignoré", milestone: true });
  saveMilestone({ project_id: p.id, day: at(3), label: "Reporté", milestone: true });
  saveMilestone({ project_id: p.id, day: at(4), label: "Fait", milestone: true });
  const key = (label: string) => today().find((i) => i.text.includes(label))!.key;
  const [k1, k2, k3] = [key("Ignoré"), key("Reporté"), key("Fait")];
  setTodayState(k1, "ignored"); setTodayState(k2, "snoozed"); setTodayState(k3, "done");
  const now = today().map((i) => i.key);
  assert.ok(!now.includes(k1) && !now.includes(k2) && !now.includes(k3));
  const tomorrow = today(new Date(Date.now() + 86400000)).map((i) => i.key);
  assert.ok(!tomorrow.includes(k1) && tomorrow.includes(k2) && tomorrow.includes(k3));
});

test("aujourd'hui : la même alerte avec un autre pourcentage garde sa clé", () => {
  assert.equal(alertKey({ project: "p", text: "P · visites en baisse de 31 %" }), alertKey({ project: "p", text: "P · visites en baisse de 34 %" }));
  assert.notEqual(alertKey({ project: "p", text: "P · visites en baisse de 31 %" }), alertKey({ project: "q", text: "P · visites en baisse de 31 %" }));
});

test("aujourd'hui : un jalon à J-3 apparaît avec son compte à rebours, pas à J-8", () => {
  const p = saveProject(null, { name: "Jal" })!;
  saveMilestone({ project_id: p.id, day: at(3), label: "Lancement V2", milestone: true });
  saveMilestone({ project_id: p.id, day: at(8), label: "Salon lointain", milestone: true });
  const items = today();
  assert.ok(items.some((i) => i.kind === "jalon" && i.text === "Jal · Lancement V2 dans 3 jours"));
  assert.ok(!items.some((i) => i.text.includes("Salon lointain")));
});

test("aujourd'hui : actions Google seulement si le module est actif sur le projet", () => {
  db.prepare("INSERT INTO sites (id, domain, name, gsc_property, created_at) VALUES ('go', 'go.fr', 'go.fr', 'sc-domain:go.fr', 0)").run();
  db.prepare("INSERT INTO gsc_rows (site_id, day, query, page, clicks, impressions, position) VALUES ('go', ?, 'meilleur outil seo', '', 3, 400, 7.2)").run(at(-3));
  const p = saveProject(null, { name: "Go", sites: ["go.fr"] })!;
  setEnabled("google", true); setProjectModule(p.id, "google", false);
  assert.ok(!today().some((i) => i.kind === "action" && i.project_id === p.id));
  setProjectModule(p.id, "google", true);
  const a = today().find((i) => i.kind === "action" && i.project_id === p.id)!;
  assert.equal(a.text, "Go · faire monter « meilleur outil seo » (position 7,2, 400 impressions)");
  assert.equal(a.metric, "Clics Google");
});

test("aujourd'hui : relances CRM par projet, une seule fois (plus dans les alertes du portefeuille)", async () => {
  const { portfolio } = await import("./portfolio.ts");
  setEnabled("crm", true);
  const p = saveProject(null, { name: "Crm", crm_key: "crm" })!;
  setProjectModule(p.id, "crm", true);
  db.prepare("INSERT INTO contacts (id, name, project, stage, tags, opt_out, next_at, created_at, updated_at) VALUES ('r1', 'Ana', 'crm', 'contacted', '[]', 0, ?, 0, 0)").run(at(-1));
  assert.equal(today().filter((i) => i.text.includes("relance")).length, 1);
  assert.ok(!portfolio({ from: at(-7), to: at(0) }).alerts.some((a) => a.text.includes("relance")));
});

test("aujourd'hui : une alerte ignorée revient si le problème disparaît puis revient", async () => {
  const { registerJob, tick } = await import("./jobs.ts");
  let fail = true;
  registerJob("projets", { id: "test-retour", every: "30m", run: async () => { if (fail) throw new Error("panne"); } });
  let t = Date.now() + 20 * 86400000;
  const run = async (n: number) => { for (let i = 0; i < n; i++) { await tick(t); t += 31 * 60_000; } };
  const find = () => today().find((i) => i.text.includes("test-retour"));
  await run(3);
  setTodayState(find()!.key, "ignored");
  assert.equal(find(), undefined);
  fail = false; await run(1);
  assert.equal(find(), undefined);
  fail = true; await run(3);
  assert.ok(find(), "l'alerte revient après résolution");
});
