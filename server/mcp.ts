import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { z } from "zod";
import { db, type Site } from "./db.ts";
import { lastDays, searchStats, strikingDistance, trafficStats, type Range } from "./stats.ts";
import { gscConfigured, syncSite } from "./gsc.ts";
import { registerBusinessTools } from "./business.ts";
import { registerProjectTools } from "./projects.ts";
import { instrument } from "./agents.ts";
import { registerDashboardTools } from "./dashboards.ts";
import { registerPortfolioTools } from "./portfolio.ts";
import { registerConnectionTools } from "./connectors/api.ts";
import { activeModules } from "./modules/state.ts";
import { registerModuleTools } from "./modules/api.ts";
import { jobsStatus } from "./jobs.ts";
import { registerKpiTools } from "./sources.ts";
import { registerTodayTools } from "./today.ts";

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

function build(readOnly = false, agent = "Clé principale") {
  const server = new McpServer({ name: "searchtide", version: "0.2.0" }, { instructions: INSTRUCTIONS });
  instrument(server, agent);

  registerModuleTools(server, readOnly);
  for (const m of activeModules()) (m.mcp ?? ((s: McpServer, o: { readOnly: boolean; agent: string }) => BUILTIN_TOOLS[m.id]?.(s, o.readOnly, o.agent)))(server, { readOnly, agent });
  return server;
}

/** Point d'entrée MCP en Streamable HTTP, sans état (un serveur par requête). */
export async function handleMcp(req: Request, opts: { readOnly?: boolean; agent?: string } = {}): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await build(opts.readOnly, opts.agent).connect(transport);
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
