// API des modules : liste et état, activation pour l'instance (session administrateur) et pour un projet (session ou clé en écriture).
import type { Hono } from "hono";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { db } from "../db.ts";
import { isAdmin, viewerOf } from "../admin.ts";
import { connections } from "../connections.ts";
import { allModules, getModule } from "./index.ts";
import { isEnabled, setEnabled, setProjectModule } from "./state.ts";

type Row = Record<string, any>;
// Connecteurs intégrés : rien à connecter
const INTEGRATED = new Set(["analytics", "manual"]);
const needed = (id: string) => (getModule(id)?.connectors ?? []).filter((c) => !INTEGRATED.has(c));

export function modulesList() {
  return allModules().map((m) => {
    const conns = needed(m.id).map((c) => ({ id: c, list: connections(c) }));
    const enabled = isEnabled(m.id);
    const reconnect = conns.some((c) => c.list.some((x) => x.status === "reconnect" || x.status === "error"));
    const projects = m.scope === "projet" && !m.core
      ? (db.prepare("SELECT project_id FROM project_modules WHERE module_id = ? AND enabled = 1").all(m.id) as Row[]).map((r) => r.project_id)
      : [];
    return { id: m.id, name: m.name, description: m.description, category: m.category, core: !!m.core, scope: m.scope, tabs: m.tabs ?? [],
      enabled, status: !enabled ? "inactif" : reconnect ? "a-reconnecter" : "actif", projects,
      connectors: conns.map((c) => ({ id: c.id, connected: c.list.length > 0 })) };
  });
}

/**
 * Active ou retire un module pour un projet. Activer exige une connexion existante si le module en dépend
 * (une clé ne crée jamais de connexion) ; le module est alors aussi activé pour l'instance.
 */
export function enableForProject(projectId: string, moduleId: string, on: boolean, settings?: Record<string, unknown>) {
  const m = getModule(moduleId);
  if (!m) throw new Error(`Module inconnu : ${moduleId}`);
  if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) throw new Error("Projet introuvable");
  if (m.core) throw new Error(`${m.name} est toujours actif.`);
  if (m.scope !== "projet") throw new Error(`${m.name} s'active pour toute l'instance, dans Modules.`);
  if (on) {
    const req = needed(m.id);
    if (req.length && !req.some((c) => connections(c).length)) throw new Error(`Connectez d'abord ${m.name} dans Modules.`);
    if (!isEnabled(m.id)) setEnabled(m.id, true);
  }
  setProjectModule(projectId, m.id, on, settings);
}

export function registerModules(app: Hono) {
  app.get("/api/modules", (c) => c.json(modulesList()));
  app.post("/api/modules/:id", async (c) => {
    if (!isAdmin(c)) return c.json({ error: "Réservé à l'administrateur : activez les modules depuis l'interface." }, 403);
    const b = await c.req.json().catch(() => ({})) as Row;
    try { setEnabled(c.req.param("id"), !!b.enabled); return c.json({ ok: true }); }
    catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });
  app.put("/api/projects/:id/modules/:module", async (c) => {
    // Les clés en lecture seule sont déjà arrêtées avant (méthode non GET) ; reste la session et les clés en écriture.
    if (viewerOf(c) === "anon") return c.json({ error: "Connexion requise" }, 403);
    const b = await c.req.json().catch(() => ({})) as Row;
    try { enableForProject(c.req.param("id"), c.req.param("module"), !!b.enabled, b.settings && typeof b.settings === "object" ? b.settings : undefined); return c.json({ ok: true }); }
    catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });
}

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

export function registerModuleTools(server: McpServer, readOnly: boolean) {
  server.registerTool("modules_list", { description: "Modules de l'instance : actifs ou non, projets concernés, connexions présentes (sans aucun secret)." },
    async () => json(modulesList()));
  if (readOnly) return;
  const args = z.object({ project: z.string().describe("id du projet"), module: z.string().describe("id du module, voir modules_list") });
  server.registerTool("module_enable_for_project", { description: "Active un module pour un projet. La connexion du module doit déjà exister (elle se crée dans l'interface).", inputSchema: args },
    async ({ project, module }) => { enableForProject(project, module, true); return json({ ok: true }); });
  server.registerTool("module_disable_for_project", { description: "Retire un module d'un projet. Ses données et réglages sont conservés.", inputSchema: args },
    async ({ project, module }) => { enableForProject(project, module, false); return json({ ok: true }); });
}
