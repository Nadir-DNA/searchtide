// Sources d'un projet : quelles connexions alimentent ses indicateurs, rattachement d'une connexion en quelques clics (P6),
// et propriété Search Console de chacun de ses sites (Q-N4 : la propriété est une colonne du site, elle ne crée aucun indicateur).
import type { Context, Hono } from "hono";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { isAdmin, viewerOf } from "./admin.ts";
import { connections, getConnection } from "./connections.ts";
import { db } from "./db.ts";
import { get } from "./connectors/registry.ts";
import { currencyUnit } from "./connectors/stripe.ts";
import { collect, saveIndicator } from "./projects.ts";
import "./connectors/index.ts";
import { gscPropertyFor } from "./gsc.ts";
import { activeModules, enabledFor } from "./modules/state.ts";
import { getModule as getModuleDef, type KpiOffer } from "./modules/index.ts";

type Row = Record<string, any>;
const forbidden = (c: Context) => c.json({ error: "Réservé à l'administrateur : connectez-vous avec le mot de passe de l'instance." }, 403);

const projectRow = (id: string) => db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row | undefined;
const sameConfig = (a: Row, b: Row) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

/** Ce qui alimente le projet : une ligne par connexion utilisée, les indicateurs encore en ancien mode (variable d'environnement), et les sites avec leur propriété Search Console. */
export function projectSources(id: string) {
  const p = projectRow(id);
  if (!p) return null;
  const inds = db.prepare("SELECT id, label, source, config, last_error FROM indicators WHERE project_id = ? AND source NOT IN ('manual', 'site') ORDER BY position, created_at").all(id) as Row[];
  const conns = new Map(connections().map((c) => [c.id, c]));
  const groups = new Map<string, Row>();
  const legacy: Row[] = [];
  for (const i of inds) {
    const cfg = JSON.parse(i.config) as Row;
    const item = { id: i.id, label: i.label, error: i.last_error };
    if (cfg.connection_id) {
      const c = conns.get(cfg.connection_id);
      const key = cfg.connection_id as string;
      if (!groups.has(key)) groups.set(key, c
        ? { connection: { id: c.id, kind: c.kind, label: c.label, hint: c.config?.hint ?? "", status: c.status, name: get(c.kind)?.name ?? c.kind, monogram: get(c.kind)?.monogram ?? "??" }, indicators: [] }
        : { connection: null, indicators: [] }); // connexion retirée
      groups.get(key)!.indicators.push(item);
    } else legacy.push({ ...item, via: cfg.env ? "env" : "libre" });
  }
  const names = JSON.parse(p.sites) as string[];
  const sites = names.map((d) => db.prepare("SELECT id, domain, gsc_property FROM sites WHERE domain = ?").get(d) as Row | undefined).filter(Boolean);
  const hasProductData = inds.some((i) => ["pg", "http"].includes(i.source));
  return { groups: [...groups.values()], legacy, sites, google: connections("google").length > 0, productDb: hasProductData };
}

type Planned = { label: string; unit: string | null; mode: "daily" | "total"; source: string; config: Row };

/** Indicateur à créer pour un KPI d'une connexion (champs requis vérifiés, unité de la devise). */
function planItem(conn: Row, it: Row): Planned {
  const m = get(conn.kind);
  const kpi = m?.kpis?.find((k) => k.id === it.kpi);
  if (!m?.toIndicator || !kpi) throw new Error(`Indicateur inconnu : ${String(it.kpi)}`);
  const params: Row = Object.fromEntries((kpi.params ?? []).map((f) => [f.key, String(it.params?.[f.key] ?? f.default ?? "").trim()]));
  const missing = (kpi.params ?? []).find((f) => f.required && !params[f.key]);
  if (missing) throw new Error(`Champ requis : ${missing.label}`);
  const { source, config } = m.toIndicator(kpi, params);
  return { label: String(it.label ?? "").trim().slice(0, 100) || kpi.label, unit: kpi.money ? currencyUnit(conn.config.currency) : kpi.unit ?? null, mode: kpi.mode, source, config: { ...config, connection_id: conn.id } };
}

// KPI calculés sur le trafic et la Search Console d'un site du projet (source « site », sans connexion)
const SITE_KPIS: Record<string, { module: string; label: string }> = {
  visitors: { module: "analytics", label: "Visites" }, pageviews: { module: "analytics", label: "Pages vues" },
  ai_visitors: { module: "analytics", label: "Visites venues des IA" }, event: { module: "analytics", label: "Événement" },
  clicks: { module: "google", label: "Clics Google" }, impressions: { module: "google", label: "Impressions Google" },
};
const siteLabel = (metric: string, v: Row) => `${metric === "event" ? `Événement « ${v.event} »` : SITE_KPIS[metric].label} · ${v.domain}`;

function sitePlan(kpi: string, v: Row): Planned {
  if (!SITE_KPIS[kpi]) throw new Error(`Indicateur inconnu : ${kpi}`);
  if (!v.domain) throw new Error("Champ requis : site");
  return { label: siteLabel(kpi, v), unit: null, mode: "daily", source: "site", config: { domain: String(v.domain), metric: kpi, ...(kpi === "event" ? { event: String(v.event ?? "") } : {}) } };
}

const existingOf = (pid: string) => (db.prepare("SELECT source, config FROM indicators WHERE project_id = ?").all(pid) as Row[]).map((r) => ({ source: r.source, config: JSON.parse(r.config) as Row }));
const isTracked = (ex: { source: string; config: Row }[], x: { source: string; config: Row }) => ex.some((e) => e.source === x.source && sameConfig(e.config, x.config));

/** Tout ce que les modules actifs du projet savent mesurer, groupé par module (spec §5.3). */
export function kpiCatalog(projectId: string): { module: string; name: string; offers: KpiOffer[] }[] {
  const p = projectRow(projectId);
  if (!p) return [];
  const ex = existingOf(projectId);
  const domains = JSON.parse(p.sites) as string[];
  const groups: { module: string; name: string; offers: KpiOffer[] }[] = [];
  for (const mod of activeModules(projectId)) {
    const offers: KpiOffer[] = [];
    const siteOffer = (kpi: string, values: Row) => {
      const x = sitePlan(kpi, values);
      offers.push({ module: mod.id, connection_id: null, kpi, label: x.label, values, already: isTracked(ex, x) });
    };
    for (const d of domains) {
      if (mod.id === "analytics") {
        for (const k of ["visitors", "pageviews", "ai_visitors"]) siteOffer(k, { domain: d });
        const names = db.prepare("SELECT DISTINCT e.name FROM events e JOIN sites s ON s.id = e.site_id WHERE s.domain = ? AND e.type = 'event' AND e.name IS NOT NULL AND e.day >= date('now', '-90 days') ORDER BY e.name").all(d) as Row[];
        for (const n of names) siteOffer("event", { domain: d, event: n.name });
      }
      if (mod.id === "google" && gscPropertyFor(d, projectId)) for (const k of ["clicks", "impressions"]) siteOffer(k, { domain: d });
    }
    for (const kind of mod.connectors ?? []) for (const conn of connections(kind)) {
      const m = get(kind);
      for (const k of m?.toIndicator ? m.kpis ?? [] : []) {
        const label = `${k.label}${connections(kind).length > 1 ? ` · ${conn.label || m!.name}` : ""}`;
        let already = false;
        if (!k.params?.some((f) => f.required)) try { already = isTracked(ex, planItem(conn, { kpi: k.id })); } catch { /* champs à remplir */ }
        offers.push({ module: mod.id, connection_id: conn.id, kpi: k.id, label, unit: k.unit, params: k.params, already });
      }
    }
    if (mod.id === "projets") offers.push({ module: "projets", connection_id: null, kpi: "manual", label: "Saisie manuelle" }, { module: "projets", connection_id: null, kpi: "formula", label: "KPI calculé" });
    if (offers.length) groups.push({ module: mod.id, name: mod.name, offers });
  }
  return groups;
}

/** Ajoute un KPI du catalogue au projet (même chemin pour l'interface et l'outil MCP kpi_add). Un KPI déjà suivi n'est pas recréé. */
export async function addKpi(projectId: string, o: { module: string; connection_id?: string | null; kpi: string; params?: Row; label?: string }) {
  if (!projectRow(projectId)) throw new Error("Projet introuvable");
  if (!enabledFor(projectId, o.module)) throw new Error(`Le module ${o.module} n'est pas actif pour ce projet.`);
  let x: Planned;
  if (o.connection_id) {
    const conn = getConnection(o.connection_id);
    if (!conn || !(getModuleDef(o.module)?.connectors ?? []).includes(conn.kind)) throw new Error("Connexion introuvable pour ce module");
    x = planItem(conn, { kpi: o.kpi, params: o.params, label: o.label });
  } else if (o.kpi === "manual") {
    x = { label: String(o.label ?? o.params?.label ?? "").trim().slice(0, 100), unit: o.params?.unit ? String(o.params.unit) : null, mode: o.params?.mode === "total" ? "total" : "daily", source: "manual", config: {} };
    if (!x.label) throw new Error("Champ requis : nom");
  } else if (o.kpi === "formula") {
    let terms: unknown;
    try { terms = typeof o.params?.terms === "string" ? JSON.parse(o.params.terms) : o.params?.terms; } catch { throw new Error("Termes de la formule illisibles"); }
    x = { label: String(o.label ?? "").trim().slice(0, 100), unit: o.params?.unit ? String(o.params.unit) : null, mode: "total", source: "formula",
      config: { terms, ...(o.params?.scale ? { scale: Number(o.params.scale) } : {}) } };
    if (!x.label) throw new Error("Champ requis : nom");
  } else x = { ...sitePlan(o.kpi, o.params ?? {}), ...(o.label ? { label: String(o.label).slice(0, 100) } : {}) };
  if (x.source !== "manual" && x.source !== "formula" && isTracked(existingOf(projectId), x)) throw new Error(`« ${x.label} » est déjà suivi sur ce projet.`);
  const ind = saveIndicator(null, projectId, x)!;
  if (!["manual", "site", "formula"].includes(x.source)) await collect(ind, 90).catch(() => {}); // l'erreur éventuelle reste visible sur l'indicateur
  return ind;
}

export function registerSources(app: Hono) {
  // Catalogue de KPI : session ou clé (les clés en lecture seule sont arrêtées avant sur POST)
  app.get("/api/projects/:id/kpi-catalog", (c) => projectRow(c.req.param("id")) ? c.json(kpiCatalog(c.req.param("id"))) : c.json({ error: "Projet introuvable" }, 404));
  app.post("/api/projects/:id/kpis", async (c) => {
    if (viewerOf(c) === "anon") return forbidden(c);
    const b = await c.req.json().catch(() => ({})) as Row;
    try { return c.json(await addKpi(c.req.param("id"), { module: String(b.module ?? ""), connection_id: b.connection_id ?? null, kpi: String(b.kpi ?? ""), params: b.params, label: b.label }), 201); }
    catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });
  app.get("/api/projects/:id/sources", (c) => {
    if (!isAdmin(c)) return forbidden(c);
    const r = projectSources(c.req.param("id"));
    return r ? c.json(r) : c.json({ error: "Projet introuvable" }, 404);
  });

  // Rattacher une connexion : crée les indicateurs cochés avec config.connection_id
  app.post("/api/projects/:id/sources", async (c) => {
    if (!isAdmin(c)) return forbidden(c);
    const pid = c.req.param("id");
    if (!projectRow(pid)) return c.json({ error: "Projet introuvable" }, 404);
    const b = await c.req.json().catch(() => ({})) as Row;
    const conn = getConnection(String(b.connection_id ?? ""));
    if (!conn) return c.json({ error: "Connexion introuvable" }, 404);
    const m = get(conn.kind);
    if (!m?.toIndicator || !m.kpis?.length) return c.json({ error: `${m?.name ?? conn.kind} ne fournit pas d'indicateur à rattacher.` }, 400);
    const items = Array.isArray(b.items) ? b.items as Row[] : [];
    if (!items.length) return c.json({ error: "Cochez au moins un indicateur." }, 400);
    // Tout est validé avant la première écriture
    const plan: Planned[] = [];
    for (const it of items) {
      try { plan.push(planItem(conn, it)); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
    }
    const existing = existingOf(pid);
    const created: Row[] = [], skipped: string[] = [];
    try {
      for (const x of plan) {
        if (existing.some((e) => e.source === x.source && sameConfig(e.config, x.config))) { skipped.push(x.label); continue; }
        const ind = saveIndicator(null, pid, { label: x.label, unit: x.unit, mode: x.mode, source: x.source, config: x.config }, isAdmin(c))!;
        await collect(ind, 90).catch(() => {}); // l'erreur éventuelle reste visible sur l'indicateur
        created.push({ id: ind.id, label: ind.label });
      }
    } catch (e) { return c.json({ error: (e as Error).message }, 400); }
    return c.json({ created, skipped }, 201);
  });
}

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

export function registerKpiTools(server: McpServer, readOnly: boolean) {
  server.registerTool("kpi_catalog", { description: "KPI qu'un projet peut suivre avec ses modules actifs (already : déjà suivi). À ajouter avec kpi_add.", inputSchema: z.object({ project: z.string() }) },
    async ({ project }) => json(kpiCatalog(project)));
  if (readOnly) return;
  server.registerTool("kpi_add", {
    description: "Ajoute au projet un KPI du catalogue (kpi_catalog) : module, connection_id s'il y en a une, kpi, et params (values du catalogue, ou champs requis comme le package Play).",
    inputSchema: z.object({ project: z.string(), module: z.string(), connection_id: z.string().nullable().optional(), kpi: z.string(),
      params: z.record(z.string(), z.string()).optional(), label: z.string().optional() }),
  }, async ({ project, ...o }) => json(await addKpi(project, o)));
}
