// Pages personnalisables : chaque page est une grille de blocs (type, taille, options), modifiable dans l'interface ou par les agents (MCP).
import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { db } from "./db.ts";
import { migrate } from "./migrations.ts";
import { allModules, type WidgetDef } from "./modules/index.ts";
import { isEnabled } from "./modules/state.ts";
import { visibleProjectIds } from "./agents.ts";

type Row = Record<string, any>;
migrate("dashboards-1", `CREATE TABLE dashboards (id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT, position INTEGER NOT NULL DEFAULT 0,
  widgets TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL, updated_by TEXT)`);

/** Catalogue des blocs : la réunion des blocs déclarés par les modules (server/modules), lue à chaque appel. */
export const widgetDefs = (): Record<string, WidgetDef> => Object.fromEntries(allModules().flatMap((m) => Object.entries(m.widgets ?? {})));
/** Catalogue avec, pour chaque bloc, son module et s'il est disponible (module actif). */
export function widgetCatalog(): Record<string, WidgetDef & { module: string; moduleName: string; available: boolean }> {
  const out: Record<string, WidgetDef & { module: string; moduleName: string; available: boolean }> = {};
  for (const m of allModules()) for (const [k, w] of Object.entries(m.widgets ?? {})) out[k] = { ...w, module: m.id, moduleName: m.name, available: isEnabled(m.id) };
  return out;
}
export const SIZES = ["quarter", "third", "half", "two-thirds", "full"] as const;

const widget = z.object({
  id: z.string().min(1).max(40).default(() => randomUUID().slice(0, 8)),
  type: z.string().refine((t) => t in widgetDefs(), "Type de bloc inconnu, voir le catalogue"),
  size: z.enum(SIZES).optional(),
  title: z.string().max(80).optional(),
  options: z.record(z.string(), z.union([z.string().max(20_000), z.number(), z.boolean()])).default({}),
}).transform((w) => ({ ...w, size: w.size ?? widgetDefs()[w.type].size }));
export type Widget = z.infer<typeof widget>;
const widgets = z.array(widget).max(60);

const DEFAULT: Omit<Widget, "id">[] = [
  { type: "pulse", size: "full", options: {} },
  { type: "traffic_by_project", size: "two-thirds", options: {} },
  { type: "todo", size: "third", options: {} },
  { type: "projects_table", size: "full", options: {} },
  { type: "pipeline", size: "half", options: {} },
  { type: "publications", size: "half", options: {} },
];

type Dashboard = { id: string; name: string; icon: string | null; position: number; updated_at: number; updated_by: string | null; widgets: Widget[] };
const decode = (r: Row): Dashboard => ({ ...(r as Dashboard), widgets: JSON.parse(r.widgets) });
export function listDashboards() {
  if (!(db.prepare("SELECT COUNT(*) AS n FROM dashboards").get() as Row).n)
    createDashboard("Vue d'ensemble", DEFAULT.map((w, i) => ({ ...w, id: `w${i + 1}` })), "système");
  return (db.prepare("SELECT * FROM dashboards ORDER BY position, updated_at").all() as Row[]).map(decode);
}
export function getDashboard(idOrName: string) {
  listDashboards();
  const r = db.prepare("SELECT * FROM dashboards WHERE id = ? OR lower(name) = lower(?)").get(idOrName, idOrName) as Row | undefined;
  if (!r) throw new Error(`Page introuvable : ${idOrName}. Voir dashboard_list.`);
  return decode(r);
}
export function createDashboard(name: string, ws: unknown = [], by = "interface") {
  const id = randomUUID().slice(0, 8);
  const pos = (db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM dashboards").get() as Row).p;
  db.prepare("INSERT INTO dashboards (id, name, position, widgets, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, z.string().trim().min(1).max(40).parse(name), pos, JSON.stringify(widgets.parse(ws)), Date.now(), by);
  return getDashboard(id);
}
export function saveDashboard(id: string, patch: { name?: string; widgets?: unknown; position?: number }, by = "interface") {
  const cur = getDashboard(id);
  const name = patch.name != null ? z.string().trim().min(1).max(40).parse(patch.name) : cur.name;
  const ws = patch.widgets != null ? widgets.parse(patch.widgets) : cur.widgets;
  if (new Set(ws.map((w) => w.id)).size !== ws.length) throw new Error("Deux blocs ont le même id");
  db.prepare("UPDATE dashboards SET name = ?, widgets = ?, position = ?, updated_at = ?, updated_by = ? WHERE id = ?")
    .run(name, JSON.stringify(ws), patch.position ?? cur.position, Date.now(), by, cur.id);
  return getDashboard(cur.id);
}
export function deleteDashboard(id: string) {
  const cur = getDashboard(id);
  if (listDashboards().length <= 1) throw new Error("Impossible de supprimer la dernière page");
  db.prepare("DELETE FROM dashboards WHERE id = ?").run(cur.id);
}

/** Opérations bloc par bloc (plus simples pour un agent que de réécrire toute la page). */
export function editWidgets(id: string, by: string, op:
  | { op: "add"; widget: unknown; index?: number }
  | { op: "update"; widget_id: string; patch: Partial<Widget> }
  | { op: "remove"; widget_id: string }
  | { op: "move"; widget_id: string; index: number }) {
  const ws = [...getDashboard(id).widgets];
  const at = "widget_id" in op ? ws.findIndex((w) => w.id === op.widget_id) : -1;
  if ("widget_id" in op && at < 0) throw new Error(`Bloc introuvable : ${op.widget_id}`);
  if (op.op === "add") ws.splice(op.index ?? ws.length, 0, widget.parse(op.widget));
  if (op.op === "update") ws[at] = widget.parse({ ...ws[at], ...op.patch, options: { ...ws[at].options, ...op.patch.options }, id: ws[at].id });
  if (op.op === "remove") ws.splice(at, 1);
  if (op.op === "move") { const [w] = ws.splice(at, 1); ws.splice(Math.max(0, Math.min(op.index, ws.length)), 0, w); }
  return saveDashboard(id, { widgets: ws }, by);
}

const err = (e: unknown) => e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")} : ${i.message}`).join(", ") : (e as Error).message;

export function registerDashboards(app: Hono) {
  app.get("/api/dashboards", (c) => {
    const agent = (c as any).get("agent");
    if (!agent) return c.json({ dashboards: listDashboards(), catalog: widgetCatalog(), sizes: SIZES });
    const ids = visibleProjectIds(agent);
    if (!ids) return c.json({ dashboards: listDashboards(), catalog: widgetCatalog(), sizes: SIZES });
    // Une clé limitée ne voit que les blocs qui ne ciblent pas un autre projet.
    const refs = (o: Record<string, unknown>) => ["project", "project_id", "projects", "crm_key"].flatMap((k) => typeof o[k] === "string" ? [String(o[k])] : Array.isArray(o[k]) ? (o[k] as unknown[]).map(String) : []);
    const scoped = listDashboards().map((d) => ({ ...d, widgets: d.widgets.filter((w) => refs(w.options).every((v) => ids.has(v))) }));
    return c.json({ dashboards: scoped, catalog: widgetCatalog(), sizes: SIZES });
  });
  app.post("/api/dashboards", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    try { return c.json(createDashboard(b.name, b.widgets ?? []), 201); } catch (e) { return c.json({ error: err(e) }, 400); }
  });
  app.put("/api/dashboards/:id", async (c) => {
    try { return c.json(saveDashboard(c.req.param("id"), await c.req.json())); } catch (e) { return c.json({ error: err(e) }, 400); }
  });
  app.delete("/api/dashboards/:id", (c) => { try { deleteDashboard(c.req.param("id")); return c.json({ ok: true }); } catch (e) { return c.json({ error: err(e) }, 400); } });
}

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const wInput = z.object({
  type: z.string().describe("Type de bloc, voir dashboard_catalog"),
  size: z.enum(SIZES).optional().describe("Largeur : quarter, third, half, two-thirds, full"),
  title: z.string().optional().describe("Titre affiché à la place du titre par défaut"),
  options: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe("Options du type (voir dashboard_catalog)"),
});

export function registerDashboardTools(server: McpServer, readOnly: boolean, agent: string) {
  server.registerTool("dashboard_catalog", { description: "Types de blocs disponibles pour les pages de Searchtide, leurs options et les tailles possibles." },
    async () => json({ widgets: widgetCatalog(), sizes: SIZES }));
  server.registerTool("dashboard_list", { description: "Pages de Searchtide (ordre du menu) avec leurs blocs." }, async () => json(listDashboards()));
  server.registerTool("dashboard_get", { description: "Une page de Searchtide et ses blocs, par id ou par nom.", inputSchema: z.object({ page: z.string() }) },
    async ({ page }) => json(getDashboard(page)));
  if (readOnly) return;
  server.registerTool("dashboard_create", {
    description: "Crée une page dans le menu de Searchtide, vide ou avec des blocs.",
    inputSchema: z.object({ name: z.string(), widgets: z.array(wInput).optional() }),
  }, async ({ name, widgets: ws }) => json(createDashboard(name, ws ?? [], agent)));
  server.registerTool("dashboard_update", {
    description: "Renomme une page, la déplace dans le menu (position, 0 = en haut) ou remplace tous ses blocs d'un coup (liste ordonnée).",
    inputSchema: z.object({ page: z.string(), name: z.string().optional(), position: z.number().int().min(0).optional(), widgets: z.array(wInput.extend({ id: z.string().optional() })).optional() }),
  }, async ({ page, ...patch }) => json(saveDashboard(page, patch, agent)));
  if (!agent) server.registerTool("dashboard_delete", { description: "Supprime une page (pas la dernière).", inputSchema: z.object({ page: z.string() }) },
    async ({ page }) => { deleteDashboard(page); return json({ ok: true }); });
  server.registerTool("widget_add", {
    description: "Ajoute un bloc à une page, à la fin ou à une position (0 = en premier).",
    inputSchema: z.object({ page: z.string(), index: z.number().int().min(0).optional() }).merge(wInput),
  }, async ({ page, index, ...w }) => json(editWidgets(page, agent, { op: "add", widget: w, index })));
  server.registerTool("widget_update", {
    description: "Modifie un bloc : taille, titre ou options (les options données remplacent celles du même nom). Ex. réécrire le texte d'une note.",
    inputSchema: z.object({ page: z.string(), widget_id: z.string(), size: z.enum(SIZES).optional(), title: z.string().optional(),
      options: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional() }),
  }, async ({ page, widget_id, ...patch }) => json(editWidgets(page, agent, { op: "update", widget_id, patch: patch as Partial<Widget> })));
  server.registerTool("widget_move", { description: "Déplace un bloc à une position de la page (0 = en premier).",
    inputSchema: z.object({ page: z.string(), widget_id: z.string(), index: z.number().int().min(0) }) },
    async ({ page, widget_id, index }) => json(editWidgets(page, agent, { op: "move", widget_id, index })));
  if (!agent) server.registerTool("widget_remove", { description: "Retire un bloc d'une page.", inputSchema: z.object({ page: z.string(), widget_id: z.string() }) },
    async ({ page, widget_id }) => json(editWidgets(page, "", { op: "remove", widget_id })));
}
