// État des modules : actifs pour l'instance (table modules) et projet par projet (table project_modules),
// plus l'activation initiale d'une instance existante d'après ce qu'elle utilise déjà (spec §8).
import { randomUUID } from "node:crypto";
import { db } from "../db.ts";
import { migrate } from "../migrations.ts";
import { allModules, getModule } from "./index.ts";
import type { Module } from "./types.ts";

type Row = Record<string, any>;
migrate("2026-11-10-modules", `
  CREATE TABLE modules (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, settings TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL);
  CREATE TABLE project_modules (project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, module_id TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1, settings TEXT NOT NULL DEFAULT '{}', PRIMARY KEY (project_id, module_id));
`);

const known = (id: string) => { const m = getModule(id); if (!m) throw new Error(`Module inconnu : ${id}`); return m; };

export function isEnabled(id: string): boolean {
  const m = getModule(id);
  if (!m) return false;
  if (m.core) return true;
  return !!(db.prepare("SELECT enabled FROM modules WHERE id = ?").get(id) as Row | undefined)?.enabled;
}

export function enabledFor(projectId: string, id: string): boolean {
  const m = getModule(id);
  if (!m || !isEnabled(id)) return false;
  if (m.core || m.scope === "instance") return true;
  return !!(db.prepare("SELECT enabled FROM project_modules WHERE project_id = ? AND module_id = ?").get(projectId, id) as Row | undefined)?.enabled;
}

export function setEnabled(id: string, on: boolean) {
  if (known(id).core) throw new Error(`${getModule(id)!.name} est un module cœur : il reste toujours actif.`);
  db.prepare("INSERT INTO modules (id, enabled, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at")
    .run(id, on ? 1 : 0, Date.now());
}

/** Désactiver garde la ligne et ses réglages : une réactivation retrouve tout. */
export function setProjectModule(projectId: string, id: string, on: boolean, settings?: Record<string, unknown>) {
  known(id);
  db.prepare(`INSERT INTO project_modules (project_id, module_id, enabled, settings) VALUES (?, ?, ?, ?)
    ON CONFLICT(project_id, module_id) DO UPDATE SET enabled = excluded.enabled${settings ? ", settings = excluded.settings" : ""}`)
    .run(projectId, id, on ? 1 : 0, JSON.stringify(settings ?? {}));
}

export function projectModuleSettings(projectId: string, id: string): Record<string, any> {
  const r = db.prepare("SELECT settings FROM project_modules WHERE project_id = ? AND module_id = ?").get(projectId, id) as Row | undefined;
  return r ? JSON.parse(r.settings) : {};
}

export const activeModules = (projectId?: string): Module[] =>
  allModules().filter((m) => projectId ? enabledFor(projectId, m.id) : isEnabled(m.id));

const SOURCE_MODULE: Record<string, string> = { pg: "produit", supabase: "produit", http: "produit", play: "google", site: "projets", manual: "projets", formula: "projets" };
export const indicatorModule = (ind: { source: string; config: Record<string, unknown> }) => SOURCE_MODULE[ind.source] ?? ind.source;

/** Indicateurs du projet dont le module n'est pas actif pour ce projet : masqués, jamais supprimés. */
export function hiddenIndicators(projectId: string): Set<string> {
  const rows = db.prepare("SELECT id, source, config FROM indicators WHERE project_id = ?").all(projectId) as Row[];
  return new Set(rows.filter((r) => !enabledFor(projectId, indicatorModule({ source: r.source, config: JSON.parse(r.config) }))).map((r) => r.id));
}

const hasTable = (t: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
const count = (t: string) => hasTable(t) ? (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as Row).n as number : 0;

/**
 * Premier démarrage en 0.3 : active ce que l'instance utilise déjà, crée un projet pour chaque site orphelin.
 * Une seule fois (ligne dans migrations), dans une transaction : une erreur laisse la base inchangée.
 */
export function activateFromExistingData() {
  const NAME = "2026-11-10-modules-activation";
  if (db.prepare("SELECT 1 FROM migrations WHERE name = ?").get(NAME)) return;
  const kinds = new Set(hasTable("connections") ? (db.prepare("SELECT DISTINCT kind FROM connections").all() as Row[]).map((r) => r.kind) : []);
  const inds = hasTable("indicators") ? db.prepare("SELECT project_id, source, config FROM indicators").all() as Row[] : [];
  const projects = hasTable("projects") ? db.prepare("SELECT id, sites, crm_key FROM projects").all() as Row[] : [];
  const sites = hasTable("sites") ? db.prepare("SELECT domain, gsc_property FROM sites").all() as Row[] : [];

  const instance = new Set(allModules().filter((m) => m.core || m.connectors?.some((c) => kinds.has(c) && c !== "analytics" && c !== "manual")).map((m) => m.id));
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) instance.add("google");
  if (process.env.SMTP_URL || process.env.NTFY_TOPIC) instance.add("notifications");
  if (count("contacts")) instance.add("crm");
  if (count("publications")) instance.add("publications");
  if (count("templates") || count("sequences")) instance.add("prospection");

  const perProject = new Map<string, Set<string>>();
  const add = (pid: string, mid: string) => { if (!getModule(mid)?.core) { (perProject.get(pid) ?? perProject.set(pid, new Set()).get(pid)!).add(mid); instance.add(mid); } };
  for (const i of inds) add(i.project_id, indicatorModule({ source: i.source, config: JSON.parse(i.config) }));
  const gsc = new Set(sites.filter((s) => s.gsc_property).map((s) => s.domain));
  for (const p of projects) {
    if ((JSON.parse(p.sites) as string[]).some((d) => gsc.has(d))) add(p.id, "google");
    if (p.crm_key) { add(p.id, "crm"); add(p.id, "publications"); }
  }
  // La propriété Search Console de chaque site est recopiée dans le réglage Google du projet ; la colonne du site reste lue en repli.
  const googleSettings = (pid: string) => {
    const p = projects.find((x) => x.id === pid)!;
    return { gsc_property: Object.fromEntries(sites.filter((x) => x.gsc_property && (JSON.parse(p.sites) as string[]).includes(x.domain)).map((x) => [x.domain, x.gsc_property])) };
  };
  const owned = new Set(projects.flatMap((p) => JSON.parse(p.sites) as string[]));
  const orphans = sites.filter((s) => !owned.has(s.domain));

  db.exec("BEGIN");
  try {
    const now = Date.now();
    for (const m of allModules()) db.prepare("INSERT OR IGNORE INTO modules (id, enabled, updated_at) VALUES (?, ?, ?)").run(m.id, instance.has(m.id) ? 1 : 0, now);
    for (const [pid, mids] of perProject) for (const mid of mids) db.prepare("INSERT OR IGNORE INTO project_modules (project_id, module_id, settings) VALUES (?, ?, ?)").run(pid, mid, JSON.stringify(mid === "google" ? googleSettings(pid) : {}));
    for (const s of orphans) {
      const pid = randomUUID();
      db.prepare("INSERT INTO projects (id, name, sites, created_at) VALUES (?, ?, ?, ?)").run(pid, s.domain, JSON.stringify([s.domain]), now);
      if (s.gsc_property && instance.has("google")) db.prepare("INSERT INTO project_modules (project_id, module_id, settings) VALUES (?, 'google', ?)").run(pid, JSON.stringify({ gsc_property: { [s.domain]: s.gsc_property } }));
    }
    db.prepare("INSERT INTO migrations (name, applied_at) VALUES (?, ?)").run(NAME, now);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  console.log(`[modules] activés : ${[...instance].sort().join(", ")} ; ${orphans.length} projet(s) créé(s) pour des sites orphelins`);
}
