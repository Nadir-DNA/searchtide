import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { SECRET_40, seed, tempDb } from "./test-server.ts";

// Lance activateFromExistingData() dans un processus fils sur la base donnée et renvoie l'état obtenu.
function activate(dbPath: string, env: Record<string, string> = {}) {
  const root = new URL("./", import.meta.url).href;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", `
    const { activateFromExistingData } = await import("${root}modules/state.ts");
    const { db } = await import("${root}db.ts");
    let error = null; try { activateFromExistingData(); } catch (e) { error = e.message; }
    console.log(JSON.stringify({ error,
      enabled: db.prepare("SELECT id FROM modules WHERE enabled = 1 ORDER BY id").all().map((r) => r.id),
      projectModules: db.prepare("SELECT p.name, m.module_id FROM project_modules m JOIN projects p ON p.id = m.project_id WHERE m.enabled = 1 ORDER BY p.name, m.module_id").all().map((r) => r.name + ":" + r.module_id),
      projects: db.prepare("SELECT name, sites FROM projects ORDER BY name").all(),
      done: !!db.prepare("SELECT 1 FROM migrations WHERE name = '2026-11-10-modules-activation'").get() }));`],
    { env: { ...process.env, DATABASE_PATH: dbPath, SECRET: SECRET_40, GOOGLE_SERVICE_ACCOUNT_JSON: "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  return JSON.parse(out.toString().trim().split("\n").at(-1)!);
}

const SEED = `
  const { db } = await import("@server/db.ts");
  const { saveProject, saveIndicator } = await import("@server/projects.ts");
  await import("@server/business.ts");
  db.prepare("INSERT INTO sites (id, domain, name, gsc_property, created_at) VALUES ('s1', 'a.fr', 'a.fr', 'sc-domain:a.fr', 0), ('s2', 'b.fr', 'b.fr', NULL, 0)").run();
  const p = saveProject(null, { name: "Alpha", sites: ["a.fr"], crm_key: "alpha" });
  saveIndicator(null, p.id, { label: "MRR", mode: "total", source: "stripe", config: { metric: "mrr", env: "STRIPE_ALPHA" } });
  db.prepare("INSERT INTO contacts (id, name, created_at, updated_at) VALUES ('c1', 'Jean', 0, 0)").run();
`;

test("migration : active ce qui est utilisé, crée un projet pour un site orphelin", () => {
  const t = tempDb();
  try {
    seed(t.path, SEED);
    const r = activate(t.path);
    assert.equal(r.error, null);
    assert.deepEqual(r.enabled, ["agents", "analytics", "crm", "google", "pages", "projets", "publications", "stripe"]);
    assert.deepEqual(r.projectModules, ["Alpha:crm", "Alpha:google", "Alpha:publications", "Alpha:stripe"]);
    assert.ok(r.projects.some((p: any) => p.name === "b.fr" && JSON.parse(p.sites).includes("b.fr")));
    assert.equal(r.done, true);
  } finally { t.done(); }
});

test("migration : un second démarrage ne réactive pas un module désactivé entre-temps", () => {
  const t = tempDb();
  try {
    seed(t.path, SEED);
    activate(t.path);
    seed(t.path, `const { setEnabled } = await import("@server/modules/state.ts"); setEnabled("crm", false);`);
    const r = activate(t.path);
    assert.ok(!r.enabled.includes("crm"));
    assert.equal(r.projects.filter((p: any) => p.name === "b.fr").length, 1);
  } finally { t.done(); }
});

test("migration : une erreur au milieu laisse la base inchangée", () => {
  const t = tempDb();
  try {
    seed(t.path, SEED);
    seed(t.path, `const { db } = await import("@server/modules/state.ts").then(() => import("@server/db.ts"));
      db.exec("CREATE TRIGGER casse BEFORE INSERT ON project_modules BEGIN SELECT RAISE(ABORT, 'panne simulée'); END");`);
    const r = activate(t.path);
    assert.match(r.error, /panne simulée/);
    assert.deepEqual(r.enabled, []);
    assert.equal(r.projects.length, 1); // pas de projet créé pour b.fr
    assert.equal(r.done, false);
  } finally { t.done(); }
});
