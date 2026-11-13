// Vue d'ensemble multi-projets : une ligne par projet (trafic, Google, argent, contacts, objectifs) et ce qui demande une action.
import type { Hono } from "hono";
import { isEnabled } from "./modules/state.ts";
import { jobAlerts } from "./jobs.ts";
import { db, localDay } from "./db.ts";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { agentLog } from "./agents.ts";
import { isAdmin } from "./admin.ts";
import { lastDays, previous, type Range } from "./stats.ts";
import { listProjects, rangeOf } from "./projects.ts";
import { visibleProjectIds } from "./agents.ts";
import { connections } from "./connections.ts";
import "./business.ts"; // tables des contacts et des publications, lues ci-dessous
import { computeHealth, crmApplicable, getWeights, registerHealth, type Weights } from "./health.ts";

type Row = Record<string, any>;
const all = (sql: string, ...p: (string | number)[]) => db.prepare(sql).all(...p) as Row[];
const ph = (n: number) => Array(n).fill("?").join(", ");

function siteTotals(ids: string[], r: Range) {
  if (!ids.length) return { visitors: 0, pageviews: 0, ai: 0, clicks: 0, impressions: 0, position: null as number | null };
  const t = all(`SELECT COUNT(DISTINCT site_id || visitor || day) AS visitors, COUNT(*) AS pageviews,
    COUNT(DISTINCT CASE WHEN channel = 'ai' THEN site_id || visitor || day END) AS ai FROM events
    WHERE site_id IN (${ph(ids.length)}) AND day BETWEEN ? AND ? AND type = 'pageview'`, ...ids, r.from, r.to)[0];
  const g = all(`SELECT COALESCE(SUM(clicks), 0) AS clicks, COALESCE(SUM(impressions), 0) AS impressions,
    ROUND(SUM(position * impressions) / NULLIF(SUM(impressions), 0), 1) AS position
    FROM gsc_rows WHERE site_id IN (${ph(ids.length)}) AND day BETWEEN ? AND ? AND query = '' AND page = ''`, ...ids, r.from, r.to)[0];
  return { visitors: t.visitors as number, pageviews: t.pageviews as number, ai: t.ai as number, clicks: g.clicks as number, impressions: g.impressions as number, position: g.position as number | null };
}

/**
 * Mesures comparables entre projets (colonnes du Portefeuille). `kind` règle l'agrégation de la ligne Total :
 * count = somme ; money = somme seulement si tous les projets ont la même devise (sinon « Devises mélangées ») ; les autres : pas de total.
 */
export const MEASURES: Record<string, { label: string; kind: "count" | "money" | "score" | "rating" | "position" | "seconds" | "ratio" | "percent"; lowerIsBetter?: boolean }> = {
  visitors: { label: "Visites", kind: "count" },
  pageviews: { label: "Pages vues", kind: "count" },
  ai_visitors: { label: "Visites venues des IA", kind: "count" },
  clicks: { label: "Clics Google", kind: "count" },
  impressions: { label: "Impressions Google", kind: "count" },
  ctr: { label: "Taux de clic Google", kind: "percent" },
  position: { label: "Position Google", kind: "position", lowerIsBetter: true },
  revenue: { label: "CA net", kind: "money" },
  mrr: { label: "MRR", kind: "money" },
  active_subscriptions: { label: "Abonnements actifs", kind: "count" },
  new_customers: { label: "Nouveaux clients", kind: "count" },
  "pagespeed:performance": { label: "Performance (PageSpeed)", kind: "score" },
  "pagespeed:seo": { label: "SEO technique (PageSpeed)", kind: "score" },
  "pagespeed:lcp": { label: "LCP (PageSpeed)", kind: "seconds", lowerIsBetter: true },
  "pagespeed:cls": { label: "CLS (PageSpeed)", kind: "ratio", lowerIsBetter: true },
  "play:rating": { label: "Note Google Play", kind: "rating" },
  "play:active_installs": { label: "Installations actives (Play)", kind: "count" },
  "play:daily_installs": { label: "Installations par jour (Play)", kind: "count" },
  leads: { label: "Nouveaux contacts", kind: "count" },
  pipeline: { label: "Montant en négociation", kind: "money" },
  followups: { label: "Relances à faire", kind: "count", lowerIsBetter: true },
  published: { label: "Publications publiées", kind: "count" },
};
type Measure = { value: number | null; previous: number | null; unit: string | null; manual?: boolean };
const SUMMED = new Set(["count", "money"]);

/** Somme des indicateurs saisis à la main portant ce rôle (CA ou contacts) ; null si aucun. `manual` sert à afficher « saisi ». */
function manualMeasure(inds: Row[], role: "revenue" | "contacts"): Measure | null {
  const list = inds.filter((i) => i.source === "manual" && i.config?.role === role && i.value != null);
  if (!list.length) return null;
  const prev = list.filter((i) => i.previous != null);
  return {
    value: list.reduce((n, i) => n + i.value, 0),
    previous: prev.length ? prev.reduce((n, i) => n + i.previous, 0) : null,
    unit: list.find((i) => i.unit)?.unit ?? null,
    manual: true,
  };
}

/** Somme des « nouveaux clients » Stripe d'un projet ; null si aucun indicateur de ce type. */
function stripeContacts(inds: Row[]): Measure | null {
  const list = inds.filter((i) => i.source === "stripe" && i.config?.metric === "new_customers" && i.value != null);
  if (!list.length) return null;
  const prev = list.filter((i) => i.previous != null);
  return { value: list.reduce((n, i) => n + i.value, 0), previous: prev.length ? prev.reduce((n, i) => n + i.previous, 0) : null, unit: null };
}

/** Valeurs des indicateurs d'un projet pour une clé de mesure (somme pour les comptes et l'argent, moyenne pour les notes). */
function indicatorMeasures(inds: Row[]): Record<string, Measure> {
  const groups = new Map<string, Row[]>();
  for (const i of inds) {
    const metric = i.config?.metric;
    const key = i.source === "stripe" ? metric : i.source === "pagespeed" || i.source === "play" ? `${i.source}:${metric}` : null;
    if (key && MEASURES[key]) groups.set(key, [...(groups.get(key) ?? []), i]);
  }
  const out: Record<string, Measure> = {};
  for (const [key, list] of groups) {
    const vals = list.filter((i) => i.value != null), prev = list.filter((i) => i.previous != null);
    if (!vals.length) continue;
    const add = (xs: Row[], f: "value" | "previous") => xs.reduce((n, i) => n + i[f], 0);
    const mean = (xs: Row[], f: "value" | "previous") => (xs.length ? add(xs, f) / xs.length : null);
    const sum = SUMMED.has(MEASURES[key].kind);
    out[key] = { value: sum ? add(vals, "value") : mean(vals, "value"), previous: prev.length ? (sum ? add(prev, "previous") : mean(prev, "previous")) : null, unit: list.find((i) => i.unit)?.unit ?? null };
  }
  return out;
}

/** Somme des indicateurs Stripe d'une métrique (chiffre d'affaires sur la période, ou MRR au dernier relevé). */
const money = (inds: Row[], metric: string, key: "value" | "previous") =>
  inds.filter((i) => i.source === "stripe" && i.config?.metric === metric && i[key] != null).reduce((n, i) => n + i[key], 0);

/** Publications publiées sur la période ; absent tant que le projet n'a aucune publication (jamais un faux zéro). */
function pubsCount(x: { id: string; crm_key: string | null }, r: Range, p: Range): Record<string, Measure> | null {
  if (!x.id) return null;
  try { return pubsCountRaw(x, r, p); } catch { return null; }   // colonne d'état absente tant que le module Publications n'a pas démarré
}
function pubsCountRaw(x: { id: string; crm_key: string | null }, r: Range, p: Range): Record<string, Measure> | null {
  const keys = [x.id, x.crm_key ?? x.id];
  const q = (from: string, to: string) => (db.prepare(`SELECT COUNT(*) AS n FROM publications WHERE project IN (?, ?) AND (status = 'published' OR state = 'published') AND day BETWEEN ? AND ?`).get(keys[0], keys[1], from, to) as Row).n as number;
  const any = (db.prepare("SELECT COUNT(*) AS n FROM publications WHERE project IN (?, ?)").get(keys[0], keys[1]) as Row).n as number;
  return any ? { published: { value: q(r.from, r.to), previous: q(p.from, p.to), unit: null } } : null;
}

export function portfolio(r: Range, weights: Weights = getWeights(), onlyIds: Set<string> | null = null) {
  const p = previous(r);
  const today = localDay();
  const sites = all(`SELECT s.id, s.domain, s.gsc_property, g.error AS sync_error,
    (SELECT MAX(day) FROM events e WHERE e.site_id = s.id AND e.type = 'pageview') AS last_visit
    FROM sites s LEFT JOIN gsc_syncs g ON g.site_id = s.id`);
  const byDomain = new Map(sites.map((s) => [s.domain, s]));
  const projects = onlyIds ? listProjects(r).filter((p) => onlyIds.has(p.id)) : listProjects(r);
  // Sites suivis qui n'appartiennent à aucun projet : regroupés pour que les totaux restent justes.
  // Pour une clé limitée, aucun site hors de sa portée n'apparaît (pas de ligne « Autres sites »).
  if (!onlyIds) {
    const claimed = new Set(projects.flatMap((x) => x.sites as string[]));
    const loose = sites.filter((s) => !claimed.has(s.domain));
    if (loose.length) projects.push({ id: "", name: "Autres sites", color: null, url: null, sites: loose.map((s) => s.domain), crm_key: null, indicators: [], funnel: [] });
  }

  const daily = new Map<string, Row>();
  const alerts: { tone: "bad" | "warn" | "info"; kind?: "objectif"; project: string | null; text: string; to: Record<string, string> }[] = [];
  const rows = projects.map((x) => {
    const ss = (x.sites as string[]).map((d) => byDomain.get(d)).filter(Boolean) as Row[];
    const ids = ss.map((s) => s.id);
    const now = siteTotals(ids, r), before = siteTotals(ids, p);
    const series = ids.length ? all(`SELECT day, COUNT(DISTINCT site_id || visitor) AS v FROM events
      WHERE site_id IN (${ph(ids.length)}) AND day BETWEEN ? AND ? AND type = 'pageview' GROUP BY day`, ...ids, r.from, r.to) : [];
    for (const d of series) daily.set(d.day, { ...daily.get(d.day), day: d.day, [x.id || "_"]: d.v });
    const inds = x.indicators as Row[];
    const crm = x.crm_key ? all(`SELECT
      SUM(created_at BETWEEN ? AND ?) AS leads, SUM(created_at BETWEEN ? AND ?) AS leads_prev,
      SUM(stage IN ('new', 'contacted', 'qualified', 'proposal')) AS open,
      SUM(next_at <= ? AND opt_out = 0 AND stage NOT IN ('won', 'lost')) AS todo,
      COALESCE(SUM(CASE WHEN stage IN ('qualified', 'proposal') THEN value END), 0) AS pipeline
      FROM contacts WHERE project = ?`, Date.parse(r.from), Date.parse(r.to) + 86399999, Date.parse(p.from), Date.parse(p.to) + 86399999, today, x.crm_key)[0] : null;
    // Indicateurs métier (hors trafic du site, déjà dans les colonnes)
    const kpis = inds.filter((i) => i.source !== "site").slice(0, 3).map((i) => ({ id: i.id, label: i.label, unit: i.unit, mode: i.mode, value: i.value, previous: i.previous, error: i.last_error }));
    const goals = inds.filter((i) => i.goal).map((i) => ({ label: i.label, unit: i.unit, ...i.goal }));
    const to: Record<string, string> = x.id ? { view: "project", id: x.id } : { site: ss[0]?.domain ?? "" };

    const broken = inds.filter((i) => i.last_error);
    if (broken.length) alerts.push({ tone: "bad", project: x.id, to, text: broken.length === 1
      ? `${x.name} · « ${broken[0].label} » ne se met plus à jour` : `${x.name} · ${broken.length} indicateurs ne se mettent plus à jour` });
    for (const s of ss) {
      if (s.sync_error) alerts.push({ tone: "bad", project: x.id, text: `${s.domain} · import Search Console en échec`, to: { site: s.domain, tab: "search" } });
      const silent = s.last_visit ? Math.round((Date.parse(today) - Date.parse(s.last_visit)) / 86400000) : null;
      if (silent == null || silent >= 3) alerts.push({ tone: "warn", project: x.id, text: silent == null ? `${s.domain} · aucune visite reçue : script de suivi absent ?` : `${s.domain} · aucune visite depuis ${silent} jours`, to: { site: s.domain, tab: "setup" } });
    }
    if (before.visitors >= 20 && now.visitors < before.visitors * 0.7) alerts.push({ tone: "warn", project: x.id, text: `${x.name} · visites en baisse de ${Math.round((1 - now.visitors / before.visitors) * 100)} %`, to });
    for (const g of goals) if (g.projection < g.target && g.elapsed / g.total >= 0.5) alerts.push({ tone: "warn", kind: "objectif", project: x.id, text: `${x.name} · objectif « ${g.label} » en retard (${g.pct} %)`, to });

    // Score de santé (04-produit §6) : tendance, objectifs, fiabilité des données, conversion, action
    const days = (d: string | null) => (d ? Math.round((Date.parse(today) - Date.parse(d)) / 86400000) : null);
    const used = [...new Set(inds.map((i) => i.config?.connection_id).filter(Boolean))] as string[];
    const connState = new Map(connections().map((c) => [c.id, c.status]));
    const first = x.funnel[0] ? inds.find((i) => i.id === x.funnel[0].id) : undefined, last = x.funnel.length > 1 ? inds.find((i) => i.id === x.funnel.at(-1).id) : undefined;
    const health = x.id ? computeHealth({
      trend: {
        visits: { now: now.visitors, before: before.visitors },
        clicks: ss.some((s) => s.gsc_property) ? { now: now.clicks, before: before.clicks } : undefined,
        revenue: inds.some((i) => i.source === "stripe" && i.config?.metric === "revenue") ? { now: money(inds, "revenue", "value"), before: money(inds, "revenue", "previous") } : undefined,
        mrr: inds.some((i) => i.source === "stripe" && i.config?.metric === "mrr") ? { now: money(inds, "mrr", "value"), before: money(inds, "mrr", "previous") } : undefined,
      },
      goals: { total: goals.length, reached: goals.filter((g) => g.projection >= g.target).length },
      reliability: {
        items: inds.length + ss.length + ss.filter((s) => s.gsc_property).length + used.length,
        errors: inds.filter((i) => i.last_error).length + ss.filter((s) => days(s.last_visit) == null || days(s.last_visit)! >= 3).length
          + ss.filter((s) => s.gsc_property && s.sync_error).length + used.filter((id) => connState.get(id) !== "connected").length,
      },
      conversion: first && last ? { steps: x.funnel.length, now: first.value > 0 && last.value != null ? last.value / first.value : null, before: first.previous > 0 && last.previous != null ? last.previous / first.previous : null } : null,
      action: x.crm_key ? { late: crm?.todo ?? 0 } : null,
    }, weights, { crm: crmApplicable() }) : null;

    // B1 : le CA vient de Stripe si une connexion Stripe est rattachée, sinon des saisies « CA ».
    // Même logique pour les contacts : CRM s'il existe, sinon Stripe (nouveaux clients), sinon saisie « contacts ».
    // M1 : Stripe ne prend la priorité que pour la mesure réellement fournie (revenue / new_customers).
    // Un projet qui n'a que du MRR Stripe garde donc sa saisie manuelle de CA.
    const stripeRevenue = inds.some((i) => i.source === "stripe" && i.config?.metric === "revenue" && i.value != null);
    const manualRevenue = manualMeasure(inds, "revenue");
    const revenueMeasure: Measure | null = stripeRevenue
      ? { value: money(inds, "revenue", "value"), previous: money(inds, "revenue", "previous"), unit: inds.find((i) => i.source === "stripe" && i.config?.metric === "revenue")?.unit ?? "€" }
      : manualRevenue;
    const contactsMeasure: Measure | null = x.crm_key
      ? { value: crm?.leads ?? 0, previous: crm?.leads_prev ?? 0, unit: null }
      : (stripeContacts(inds) ?? manualMeasure(inds, "contacts"));
    return {
      id: x.id, name: x.name, color: x.color, url: x.url, sites: ss.map((s) => s.domain), to, health, mrrPrev: money(inds, "mrr", "previous"),
      measures: {
        ...indicatorMeasures(inds),
        ...(ids.length ? {
          visitors: { value: now.visitors, previous: before.visitors, unit: null },
          pageviews: { value: now.pageviews, previous: before.pageviews, unit: null },
          ai_visitors: { value: now.ai, previous: before.ai, unit: null },
        } : {}),
        ...(ss.some((s) => s.gsc_property) ? {
          clicks: { value: now.clicks, previous: before.clicks, unit: null }, position: { value: now.position, previous: before.position, unit: null },
          impressions: { value: now.impressions, previous: before.impressions, unit: null },
          ctr: { value: now.impressions ? (now.clicks / now.impressions) * 100 : null, previous: before.impressions ? (before.clicks / before.impressions) * 100 : null, unit: "%" },
        } : {}),
        ...(x.crm_key ? {
          pipeline: { value: crm?.pipeline ?? 0, previous: null, unit: "€" },
          followups: { value: crm?.todo ?? 0, previous: null, unit: null },
        } : {}),
        ...(pubsCount(x as { id: string; crm_key: string | null }, r, p) ?? {}),
        ...(revenueMeasure ? { revenue: revenueMeasure } : {}),
        ...(contactsMeasure ? { leads: contactsMeasure } : {}),
      } as Record<string, Measure>,
      visitors: now.visitors, visitorsPrev: before.visitors, clicks: now.clicks, clicksPrev: before.clicks,
      impressions: now.impressions, position: now.position, positionPrev: before.position,
      revenue: money(inds, "revenue", "value"), revenuePrev: money(inds, "revenue", "previous"), mrr: money(inds, "mrr", "value"),
      hasMoney: inds.some((i) => i.source === "stripe"), hasSearch: ss.some((s) => s.gsc_property),
      leads: crm?.leads ?? 0, leadsPrev: crm?.leads_prev ?? 0, open: crm?.open ?? 0, todo: crm?.todo ?? 0,
      series: Object.fromEntries(series.map((d) => [d.day, d.v])), kpis, goals,
      issues: alerts.filter((a) => a.project === x.id).length,
    };
  });
  const sum = (k: keyof (typeof rows)[number]) => rows.reduce((n, x) => n + (x[k] as number), 0);
  const search = isEnabled("google") && rows.some((x) => x.hasSearch);
  const withRevenue = rows.some((x) => x.measures.revenue || x.hasMoney);
  const crm = isEnabled("crm");
  const todo = (db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE next_at <= ? AND opt_out = 0 AND stage NOT IN ('won', 'lost')").get(today) as Row).n;
  // Les relances ne sont plus une alerte : le module CRM les propose comme action dans le fil « Aujourd'hui » (today.ts)
  const pubs = all("SELECT id, title, project, network, status FROM publications WHERE day = ? ORDER BY title", today);
  alerts.push(...jobAlerts());
  for (const x of pubs.filter((x) => x.status !== "published")) alerts.push({ tone: "info", project: null, text: `À publier aujourd'hui · ${x.title}${x.network ? ` (${x.network})` : ""}`, to: { view: "pubs" } });

  // Colonnes proposées : les mesures présentes dans au moins un projet, dans l'ordre du dictionnaire
  const columns = Object.entries(MEASURES).filter(([k]) => rows.some((x) => x.measures[k])).map(([key, m]) => ({ key, ...m }));
  return {
    range: r, today, columns,
    totals: {
      visitors: sum("visitors"), visitorsPrev: sum("visitorsPrev"),
      // null = aucune source active pour cette mesure : l'interface affiche « — », jamais 0
      clicks: search ? sum("clicks") : null, clicksPrev: search ? sum("clicksPrev") : null,
      revenue: withRevenue ? sum("revenue") : null, revenuePrev: withRevenue ? sum("revenuePrev") : null, mrr: withRevenue ? sum("mrr") : null,
      leads: crm ? sum("leads") : null, leadsPrev: crm ? sum("leadsPrev") : null, open: crm ? sum("open") : null, todo: crm ? todo : null,
    },
    projects: rows,
    daily: [...daily.values()].sort((a, b) => a.day.localeCompare(b.day)),
    alerts: alerts.sort((a, b) => ["bad", "warn", "info"].indexOf(a.tone) - ["bad", "warn", "info"].indexOf(b.tone)),
  };
}

const COLUMNS_KEY = "portfolio.columns";
db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)");
/** Colonnes choisies, dans l'ordre, enregistrées dans settings.portfolio.columns ; null tant que rien n'est choisi. */
export function getColumns(): string[] | null {
  try { const v = JSON.parse((db.prepare("SELECT value FROM settings WHERE key = ?").get(COLUMNS_KEY) as Row | undefined)?.value ?? "null"); return Array.isArray(v) ? v.filter((k) => typeof k === "string" && MEASURES[k]) : null; } catch { return null; }
}

export function registerPortfolio(app: Hono) {
  app.get("/api/portfolio", (c) => {
    const agent = (c as any).get("agent");
    return c.json(portfolio(rangeOf(c.req.query()), undefined, agent ? visibleProjectIds(agent) : null));
  });
  app.get("/api/portfolio/columns", (c) => c.json({ columns: getColumns() }));
  app.put("/api/portfolio/columns", async (c) => {
    if (!isAdmin(c)) return c.json({ error: "Réservé à l'administrateur : connectez-vous avec le mot de passe de l'instance." }, 403);
    const b = await c.req.json().catch(() => ({}));
    const cols = Array.isArray(b.columns) ? [...new Set<string>(b.columns.map(String))] : null;
    if (!cols || cols.length > 20 || cols.some((k) => !MEASURES[k])) return c.json({ error: "Colonnes inconnues." }, 400);
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(COLUMNS_KEY, JSON.stringify(cols));
    return c.json({ columns: cols });
  });
  registerHealth(app, (days, w) => portfolio(lastDays(days), w).projects.filter((p) => p.id && p.health).map((p) => ({ id: p.id, name: p.name, health: p.health! })));
}

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
export function registerPortfolioTools(server: McpServer) {
  server.registerTool("portfolio_overview", {
    description: "Vue d'ensemble de tous les projets en un appel : totaux (visites, clics Google, CA, revenu mensuel, contacts, relances), une ligne par projet et les alertes. À appeler en premier.",
    inputSchema: z.object({ days: z.number().int().min(1).max(500).default(28) }),
  }, async ({ days }) => { const o = portfolio(lastDays(days)); return json({ ...o, daily: undefined, projects: o.projects.map((p) => ({ ...p, series: undefined })) }); });
  server.registerTool("alerts", { description: "Ce qui demande une action maintenant : relevés en panne, sites sans visites, baisses, objectifs en retard, relances, publications du jour." },
    async () => json(portfolio(lastDays(7)).alerts));
  server.registerTool("agent_activity", {
    description: "Journal des appels des agents IA à Searchtide (qui a fait quoi, quand). Filtrable par agent.",
    inputSchema: z.object({ agent: z.string().optional(), limit: z.number().int().min(1).max(500).default(50) }),
  }, async ({ agent, limit }) => json(agentLog(limit, agent).map((r) => ({ ...r, at: new Date(r.ts).toISOString() }))));
}
