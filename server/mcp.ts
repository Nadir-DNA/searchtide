import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { z } from "zod";
import { db, type Site } from "./db.ts";
import { lastDays, searchStats, strikingDistance, trafficStats, type Range } from "./stats.ts";
import { gscConfigured, syncSite } from "./gsc.ts";
import { registerBusinessTools } from "./business.ts";
import { registerProjectTools } from "./projects.ts";
import { instrument } from "./agents.ts";
import { registerDashboardTools } from "./dashboards.ts";
import { portfolio, registerPortfolioTools } from "./portfolio.ts";
import { registerConnectionTools } from "./connectors/api.ts";
import { activeModules } from "./modules/state.ts";
import { registerModuleTools } from "./modules/api.ts";
import { jobsStatus } from "./jobs.ts";
import { registerKpiTools } from "./sources.ts";
import { registerTodayTools, todayAsync } from "./today.ts";

const INSTRUCTIONS = `Searchtide : tous ses projets (sites, Search Console, Stripe, indicateurs métier, CRM, publications) dans un tableau de bord.
Commencez par portfolio_overview (et alerts) pour l'état général. Les pages du tableau de bord sont personnalisables :
dashboard_catalog donne les blocs possibles, dashboard_list les pages, widget_add / widget_update / widget_move / widget_remove les modifient.
Une note (type "note") sert à laisser un briefing écrit visible par vous. Tous vos appels sont journalisés sous le nom de votre clé.`;

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

function site(domain: string): Site {
  const s = db.prepare("SELECT * FROM sites WHERE domain = ? OR id = ?").get(domain, domain) as Site | undefined;
  if (!s) throw new Error(`Site inconnu : ${domain}. Utilisez list_sites.`);
  return s;
}

const period = {
  site: z.string().describe("Domaine du site, ex. exemple.com"),
  days: z.number().int().min(1).max(500).default(28).describe("Nombre de jours jusqu'à aujourd'hui"),
};
const range = (days: number): Range => lastDays(days);

/** Ne garde que les outils dont le nom passe le filtre (registerBusinessTools sert deux modules : crm_*, pubs_*). */
function only(server: McpServer, keep: (name: string) => boolean): McpServer {
  const view = Object.create(server) as McpServer;
  (view as any).registerTool = (name: string, ...rest: unknown[]) => keep(name) ? (server.registerTool as any)(name, ...rest) : undefined;
  return view;
}

/** L1 : portée d'une clé limitée, appliquée aux outils MCP (arguments et listes). */
type McpScope = { ids: Set<string>; domains: Set<string>; crmKeys: Set<string> };

function scopeDetails(ids: Set<string>): McpScope {
  const domains = new Set<string>(), crmKeys = new Set<string>();
  for (const r of db.prepare("SELECT id, crm_key, sites FROM projects").all() as Record<string, any>[]) {
    if (!ids.has(r.id)) continue;
    if (r.crm_key) crmKeys.add(String(r.crm_key));
    try { for (const d of JSON.parse(r.sites || "[]") as string[]) domains.add(d); } catch { /* sites illisibles */ }
  }
  return { ids, domains, crmKeys };
}

const resultJson = (r: any) => r?.content?.[0]?.text ? JSON.parse(r.content[0].text) : null;
const mapResult = (r: any, fn: (d: any) => any) => {
  const data = resultJson(r);
  return data == null ? r : { ...r, content: [{ ...r.content[0], text: JSON.stringify(fn(data), null, 2) }] };
};

/** Outils inter-projets réservés à une clé sans restriction de portée. */
const SCOPE_DENIED = new Set([
  "agent_activity", "connections_list", "jobs_status", "crm_summary",
  "dashboard_create", "dashboard_update", "dashboard_delete", "widget_add", "widget_update", "widget_move", "widget_remove",
]);

/**
 * Enveloppe chaque outil MCP : refuse une cible hors portée (même message « Introuvable » que pour un objet absent),
 * et filtre les listes inter-projets. Aucun outil ne voit les autres projets d'une clé limitée.
 */
function scopeServer(server: McpServer, s: McpScope) {
  const register = server.registerTool.bind(server) as (...a: any[]) => any;
  (server as any).registerTool = (name: string, config: unknown, cb: (...a: any[]) => any) =>
    register(name, config, async (...args: any[]) => {
      const a = (args[0] ?? {}) as Record<string, any>;
      const deny = (): never => { throw new Error("Introuvable"); };
      const project = (v: unknown) => {
        if (typeof v !== "string" || !v) return null;
        return db.prepare("SELECT id, crm_key FROM projects WHERE id = ? OR crm_key = ?").get(v, v) as { id: string } | undefined;
      };
      const mustProject = (v: unknown) => { const p = project(v); if (!p || !s.ids.has(p.id)) deny(); };

      if (SCOPE_DENIED.has(name)) throw new Error("Outil réservé à une clé sans restriction de portée");
      if (typeof a.project === "string" && a.project) mustProject(a.project);
      if (typeof a.site === "string" && a.site && !s.domains.has(a.site)) deny();
      if (name === "kpi_add" || name === "kpi_catalog") mustProject(a.project);
      if (name === "milestone_save") { if (!a.project) throw new Error("Précisez le projet : une clé limitée ne crée pas de jalon global"); mustProject(a.project); }
      if (name === "indicator_record") {
        const r = db.prepare("SELECT project_id FROM indicators WHERE id = ?").get(String(a.id)) as { project_id: string } | undefined;
        if (!r || !s.ids.has(r.project_id)) deny();
      }
      if (name === "crm_get_contact" || name === "crm_log") {
        const r = db.prepare("SELECT project FROM contacts WHERE id = ?").get(String(a.id)) as { project: string | null } | undefined;
        if (!r || !r.project || !s.crmKeys.has(r.project)) deny();
      }
      if (name === "crm_save_contact") {
        if (a.id) {
          const r = db.prepare("SELECT project FROM contacts WHERE id = ?").get(String(a.id)) as { project: string | null } | undefined;
          if (!r || !r.project || !s.crmKeys.has(r.project)) deny();
        } else mustProject((a.fields as any)?.project);
      }
      if (name === "pubs_save") {
        if (a.id) {
          const r = db.prepare("SELECT project FROM publications WHERE id = ?").get(String(a.id)) as { project: string | null } | undefined;
          if (!r || !r.project || !s.crmKeys.has(r.project)) deny();
        } else mustProject((a.fields as any)?.project);
      }
      if (name === "today_update") {
        const r = db.prepare("SELECT project_id FROM today_items WHERE key = ?").get(String(a.key)) as { project_id: string | null } | undefined;
        if (!r?.project_id || !s.ids.has(r.project_id)) deny();
      }

      const result = await cb(...args);
      // Listes inter-projets : même filtrage que les routes REST.
      if (name === "list_sites") return mapResult(result, (d: any[]) => d.filter((x) => s.domains.has(x.domain)));
      if (name === "projects_kpis") return mapResult(result, (d: any[]) => d.filter((p) => s.ids.has(p.id)));
      if (name === "portfolio_overview") {
        const days = Number(a.days) || 28;
        const o = portfolio(lastDays(days), undefined, s.ids);
        return json({ ...o, daily: undefined, projects: o.projects.map((p) => ({ ...p, series: undefined })) });
      }
      if (name === "alerts") return json(portfolio(lastDays(7), undefined, s.ids).alerts);
      if (name === "today") { const items = await todayAsync(); return json(items.filter((i) => i.project_id && s.ids.has(i.project_id))); }
      if (name === "milestones_list") return mapResult(result, (d: any[]) => (a.project ? d : d.filter((m) => m.project_id && s.ids.has(m.project_id))));
      if (name === "crm_list_contacts") return mapResult(result, (d: any) => { const rows = (d.rows ?? []).filter((c: any) => c.project && s.crmKeys.has(c.project)); return { ...d, rows, total: rows.length }; });
      if (name === "pubs_list") return mapResult(result, (d: any[]) => d.filter((p) => p.project && s.crmKeys.has(p.project)));
      if (name === "dashboard_list") return mapResult(result, (d: any[]) => d.map((p) => ({ ...p, widgets: filterWidgets(p.widgets, s) })));
      if (name === "dashboard_get") return mapResult(result, (d: any) => ({ ...d, widgets: filterWidgets(d.widgets, s) }));
      return result;
    });
}

/** Un bloc de page qui cible un projet hors portée est retiré (pas seulement masqué). */
function filterWidgets(widgets: any[] | undefined, s: McpScope) {
  const refs = (o: Record<string, unknown> = {}) => ["project", "project_id", "projects", "crm_key"].flatMap((k) => typeof o[k] === "string" ? [String(o[k])] : Array.isArray(o[k]) ? (o[k] as unknown[]).map(String) : []);
  return (widgets ?? []).filter((w) => refs(w.options).every((v) => s.ids.has(v)));
}

function analyticsTools(server: McpServer) {
  server.registerTool("list_sites", { description: "Liste les sites suivis et leur liaison Search Console." },
    async () => json(db.prepare("SELECT domain, name, gsc_property FROM sites ORDER BY domain").all()));

  server.registerTool("traffic_stats", {
    description: "Visites d'un site : visiteurs, pages vues, pages, canaux (search, social, ai…), référents, pays, appareils.",
    inputSchema: z.object(period),
  }, async ({ site: d, days }) => json(trafficStats(site(d).id, range(days))));
}

function googleTools(server: McpServer, readOnly: boolean) {
  server.registerTool("search_stats", {
    description: "Données Google Search Console : clics, impressions, CTR, position moyenne, meilleurs mots-clés et pages.",
    inputSchema: z.object({ ...period, limit: z.number().int().min(1).max(500).default(50) }),
  }, async ({ site: d, days, limit }) => json(searchStats(site(d).id, range(days), limit)));

  server.registerTool("seo_opportunities", {
    description: "Mots-clés en position 4 à 20 avec beaucoup d'impressions : les plus faciles à faire passer en première page.",
    inputSchema: z.object(period),
  }, async ({ site: d, days }) => json(strikingDistance(site(d).id, range(days))));

  if (!readOnly) server.registerTool("sync_search_console", {
    description: "Relance l'import des données Search Console d'un site.",
    inputSchema: z.object({ site: period.site }),
  }, async ({ site: d }) => {
    if (!gscConfigured()) throw new Error("Search Console n'est pas configuré sur cette instance");
    return json(await syncSite(site(d)));
  });
}

/** Outils des modules livrés ; un module privé apporte les siens par Module.mcp. */
const BUILTIN_TOOLS: Record<string, (server: McpServer, readOnly: boolean, agent: string) => void> = {
  analytics: (s) => analyticsTools(s),
  google: googleTools,
  crm: (s, ro) => registerBusinessTools(only(s, (n) => n.startsWith("crm_")), ro),
  publications: (s, ro) => registerBusinessTools(only(s, (n) => n.startsWith("pubs_")), ro),
  projets: (s, ro) => { registerProjectTools(s, ro); registerPortfolioTools(s); registerKpiTools(s, ro); registerTodayTools(s, ro); },
  pages: (s, ro, agent) => registerDashboardTools(s, ro, agent),
  agents: (s) => {
    registerConnectionTools(s);
    s.registerTool("jobs_status", { description: "Tâches de fond : dernière exécution, durée, erreur et échecs consécutifs (alerte à partir de 3)." }, async () => json(jobsStatus()));
  },
};

function build(readOnly = false, agent = "Clé principale", scope: Set<string> | null = null) {
  const server = new McpServer({ name: "searchtide", version: "0.2.0" }, { instructions: INSTRUCTIONS });
  if (scope) scopeServer(server, scopeDetails(scope));
  instrument(server, agent);

  registerModuleTools(server, readOnly);
  for (const m of activeModules()) (m.mcp ?? ((s: McpServer, o: { readOnly: boolean; agent: string }) => BUILTIN_TOOLS[m.id]?.(s, o.readOnly, o.agent)))(server, { readOnly, agent });
  return server;
}

/** Point d'entrée MCP en Streamable HTTP, sans état (un serveur par requête). */
export async function handleMcp(req: Request, opts: { readOnly?: boolean; agent?: string; scope?: Set<string> | null } = {}): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await build(opts.readOnly, opts.agent, opts.scope ?? null).connect(transport);
  return transport.handleRequest(req);
}

/**
 * Droits MCP selon l'identité de la requête. Tout ce qui n'est pas reconnu explicitement — jeton inconnu,
 * démonstration anonyme — obtient un serveur en **lecture seule** : jamais d'outils d'écriture par défaut.
 * L'administrateur (cookie) et la clé principale sont les seuls contextes en écriture.
 */
export function mcpAccess(bearer: string, p: { admin: boolean; apiKey: boolean; apiKeyRead: boolean }): { readOnly: boolean; agent: string } {
  if (!bearer && p.admin) return { readOnly: false, agent: "Administrateur (session)" };
  if (p.apiKey) return { readOnly: false, agent: "Clé principale" };
  if (p.apiKeyRead) return { readOnly: true, agent: "Clé lecture seule" };
  return { readOnly: true, agent: bearer ? "Lecture seule (jeton non reconnu)" : "Démonstration (lecture seule)" };
}
