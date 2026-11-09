import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { z } from "zod";
import { db, type Site } from "./db.ts";
import { lastDays, searchStats, strikingDistance, trafficStats, type Range } from "./stats.ts";
import { gscConfigured, syncSite } from "./gsc.ts";

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

function build(readOnly = false) {
  const server = new McpServer({ name: "searchtide", version: "0.1.0" });

  server.registerTool("list_sites", { description: "Liste les sites suivis et leur liaison Search Console." },
    async () => json(db.prepare("SELECT domain, name, gsc_property FROM sites ORDER BY domain").all()));

  server.registerTool("traffic_stats", {
    description: "Visites d'un site : visiteurs, pages vues, pages, canaux (search, social, ai…), référents, pays, appareils.",
    inputSchema: z.object(period),
  }, async ({ site: d, days }) => json(trafficStats(site(d).id, range(days))));

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

  return server;
}

/** Point d'entrée MCP en Streamable HTTP, sans état (un serveur par requête). */
export async function handleMcp(req: Request, opts: { readOnly?: boolean } = {}): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await build(opts.readOnly).connect(transport);
  return transport.handleRequest(req);
}
