// Sources d'un projet : quelles connexions alimentent ses indicateurs, rattachement d'une connexion en quelques clics (P6),
// et propriété Search Console de chacun de ses sites (Q-N4 : la propriété est une colonne du site, elle ne crée aucun indicateur).
import type { Context, Hono } from "hono";
import { isAdmin } from "./admin.ts";
import { connections, getConnection } from "./connections.ts";
import { db } from "./db.ts";
import { get } from "./connectors/registry.ts";
import { currencyUnit } from "./connectors/stripe.ts";
import { collect, saveIndicator } from "./projects.ts";
import "./connectors/index.ts";

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

export function registerSources(app: Hono) {
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
    const plan: { label: string; unit: string | null; mode: "daily" | "total"; source: string; config: Row }[] = [];
    for (const it of items) {
      const kpi = m.kpis.find((k) => k.id === it.kpi);
      if (!kpi) return c.json({ error: `Indicateur inconnu : ${String(it.kpi)}` }, 400);
      const params: Row = Object.fromEntries((kpi.params ?? []).map((f) => [f.key, String(it.params?.[f.key] ?? f.default ?? "").trim()]));
      const missing = (kpi.params ?? []).find((f) => f.required && !params[f.key]);
      if (missing) return c.json({ error: `Champ requis : ${missing.label}` }, 400);
      const { source, config } = m.toIndicator(kpi, params);
      plan.push({ label: String(it.label ?? "").trim().slice(0, 100) || kpi.label, unit: kpi.money ? currencyUnit(conn.config.currency) : kpi.unit ?? null, mode: kpi.mode, source, config: { ...config, connection_id: conn.id } });
    }
    const existing = (db.prepare("SELECT source, config FROM indicators WHERE project_id = ?").all(pid) as Row[]).map((r) => ({ source: r.source, config: JSON.parse(r.config) as Row }));
    const created: Row[] = [], skipped: string[] = [];
    try {
      for (const x of plan) {
        if (existing.some((e) => e.source === x.source && sameConfig(e.config, x.config))) { skipped.push(x.label); continue; }
        const ind = saveIndicator(null, pid, { label: x.label, unit: x.unit, mode: x.mode, source: x.source, config: x.config })!;
        await collect(ind, 90).catch(() => {}); // l'erreur éventuelle reste visible sur l'indicateur
        created.push({ id: ind.id, label: ind.label });
      }
    } catch (e) { return c.json({ error: (e as Error).message }, 400); }
    return c.json({ created, skipped }, 201);
  });
}
