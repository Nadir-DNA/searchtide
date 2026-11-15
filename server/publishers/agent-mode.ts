// Publication par un agent (plan D12, variante sans recette) : un compte en mode « agent » n'est publié ni par l'API ni par
// le navigateur du serveur. À l'heure prévue, la publication attend « Action requise » ; l'agent de l'utilisateur (par
// exemple Claude dans Chrome, sur l'ordinateur où il est connecté au réseau) la lit par MCP, la publie, puis renvoie
// l'adresse du post. Sans adresse sur le bon réseau, rien n'est marqué publié.
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { db } from "../db.ts";
import { mediaFiles, publicMediaReady } from "./media.ts";

type Row = Record<string, any>;

/** Domaines où une adresse de post est acceptée comme preuve, par réseau. */
export const NETWORK_HOSTS: Record<string, string[]> = {
  x: ["x.com", "twitter.com"], linkedin: ["linkedin.com"], facebook: ["facebook.com", "fb.com"], instagram: ["instagram.com"],
  tiktok: ["tiktok.com"], youtube: ["youtube.com", "youtu.be"], pinterest: ["pinterest.com", "pinterest.fr", "pin.it"],
  reddit: ["reddit.com", "redd.it"], gbp: ["google.com", "g.page", "goo.gl"],
};
export const AGENT_WAITING = "à publier par votre agent ou à la main";

export function proofAccepted(network: string, url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  return (NETWORK_HOSTS[network] ?? []).some((h) => host === h || host.endsWith(`.${h}`));
}

const projectIds = (project: string) => {
  const p = db.prepare("SELECT id, crm_key FROM projects WHERE id = ? OR crm_key = ?").get(project, project) as Row | undefined;
  return p ? [String(p.id), String(p.crm_key ?? p.id)] : null;
};

/** Publications dues sur les comptes « agent » d'un projet : ce que l'agent doit publier, avec ses médias. */
export function agentQueue(project: string) {
  const keys = projectIds(project);
  if (!keys) throw new Error("Projet introuvable");
  const rows = db.prepare(`SELECT p.id, p.title, p.text, p.network, p.scheduled_at, p.first_comment, p.thread, a.label AS account, a.web_url, a.target
    FROM publications p JOIN pub_accounts a ON a.id = p.account_id
    WHERE a.mode = 'agent' AND p.project IN (?, ?) AND p.state = 'needs_action' ORDER BY p.scheduled_at`).all(...keys) as { id: string; title: string; text: string; network: string; scheduled_at: number; first_comment: string | null; thread: string | null; account: string; web_url: string | null; target: string | null }[];
  return rows.map((r) => ({
    ...r, thread: r.thread ? JSON.parse(r.thread) : [],
    media: mediaFiles(String(r.id)).map((m) => ({ mime: m.mime, size: m.size, url: publicMediaReady() ? m.publicUrl() : null })),
    instructions: `Publiez ce texte tel quel sur ${r.network}${r.target ? ` (r/${r.target})` : ""} avec le compte « ${r.account} », puis appelez pub_report_published avec l'adresse du post.`,
  }));
}

/** L'agent (ou l'utilisateur) a publié : l'adresse du post, sur le domaine du réseau, fait la preuve. */
export function reportPublished(id: string, url: string, by: string) {
  const p = db.prepare("SELECT p.*, a.mode FROM publications p LEFT JOIN pub_accounts a ON a.id = p.account_id WHERE p.id = ?").get(id) as Row | undefined;
  if (!p) throw new Error("Publication introuvable");
  if (p.mode !== "agent" || p.state !== "needs_action") throw new Error("Seule une publication d'un compte « agent » en attente peut être déclarée publiée");
  if (!proofAccepted(String(p.network), url)) throw new Error(`Adresse refusée : il faut l'adresse https du post sur ${p.network}`);
  const proof = new URL(url).toString(), now = Date.now();
  db.prepare("UPDATE publications SET state = 'published', status = 'published', url = ?, evidence_url = ?, published_at = ?, updated_at = ? WHERE id = ?").run(proof, proof, now, now, id);
  return { id, state: "published", url: proof, by };
}

/** `mark` enregistre la publication (état, tentative, suites) : fourni par la file pour éviter une dépendance circulaire. */
export function registerAgentPublishTools(server: McpServer, readOnly: boolean, agent: string, mark: (id: string, url: string, by: string) => unknown) {
  server.registerTool("pubs_to_publish", {
    description: "Publications à publier vous-même dans le navigateur de l'utilisateur (comptes en mode « agent ») : réseau, compte, texte exact, médias, fil et premier commentaire. Publiez exactement ce texte, puis déclarez l'adresse du post avec pub_report_published.",
    inputSchema: z.object({ project: z.string().describe("id ou clé du projet") }),
  }, async ({ project }) => ({ content: [{ type: "text" as const, text: JSON.stringify(agentQueue(project), null, 2) }] }));
  if (readOnly) return;
  server.registerTool("pub_report_published", {
    description: "Déclare publiée une publication d'un compte « agent », avec l'adresse https du post sur le réseau (preuve obligatoire). N'appelez cet outil qu'après avoir vu le post en ligne.",
    inputSchema: z.object({ project: z.string(), id: z.string(), url: z.string().url() }),
  }, async ({ project, id, url }) => {
    const keys = projectIds(project);
    const p = db.prepare("SELECT project FROM publications WHERE id = ?").get(id) as Row | undefined;
    if (!keys || !p || !keys.includes(String(p.project))) throw new Error("Introuvable");
    return { content: [{ type: "text" as const, text: JSON.stringify(mark(id, url, agent), null, 2) }] };
  });
}
