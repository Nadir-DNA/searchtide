// Actions sur le CMS (plan B4) : publier un article, corriger le titre d'une page trouvée par son adresse.
// WordPress d'abord. Les clés d'agent ne créent que des brouillons ; modifier le site en ligne reste à l'administrateur.
import type { Hono } from "hono";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { db } from "./db.ts";
import { isAdmin } from "./admin.ts";
import { connections, getSecrets } from "./connections.ts";
import { currentCtx } from "./connectors/use.ts";
import { hostAllowed } from "./pagecheck.ts";
import { wpBase, wpFetch } from "./connectors/wordpress.ts";
import type { Cfg } from "./connectors/types.ts";

type Row = Record<string, any>;

/** Connexion WordPress dont l'adresse est sur le domaine du site (ou un sous-domaine). */
export function wordpressFor(domain: string): { id: string; cfg: Cfg } | null {
  for (const c of connections("wordpress")) {
    try {
      const host = new URL(String(c.config.url)).hostname;
      if (hostAllowed(domain)(host) || hostAllowed(host)(domain)) return { id: c.id, cfg: { config: c.config, secrets: getSecrets(c.id), label: c.label } };
    } catch { /* connexion illisible : on passe */ }
  }
  return null;
}

/** Texte simple ou Markdown léger → HTML (titres #, listes -, paragraphes, gras, liens). */
export function toHtml(text: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  return text.trim().split(/\n{2,}/).map((block) => {
    const lines = block.split("\n");
    const h = /^(#{1,4})\s+(.*)$/.exec(block);
    if (h && lines.length === 1) return `<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`;
    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ""))}</li>`).join("")}</ul>`;
    return `<p>${lines.map(inline).join("<br>")}</p>`;
  }).join("\n");
}

export async function publishArticle(domain: string, input: { title: string; content: string; status?: string; date?: string }) {
  const wp = wordpressFor(domain);
  if (!wp) throw new Error(`Aucune connexion WordPress pour ${domain} : ajoutez-la dans Connexions`);
  const title = String(input.title ?? "").trim(), content = String(input.content ?? "").trim();
  if (!title || !content) throw new Error("Titre et contenu requis");
  const status = input.status === "publish" ? "publish" : input.status === "future" && input.date ? "future" : "draft";
  const post = await wpFetch(wp.cfg, currentCtx(), "/posts", { method: "POST", body: { title, content: toHtml(content), status, ...(status === "future" ? { date: input.date } : {}) } });
  return { id: post.id, status: post.status, link: post.link, edit: `${wpBase(wp.cfg)}/wp-admin/post.php?post=${post.id}&action=edit` };
}

/** Trouve l'article ou la page d'une adresse publique (par son identifiant d'URL), puis change son titre. */
export async function fixTitle(domain: string, url: string, title: string) {
  const wp = wordpressFor(domain);
  if (!wp) throw new Error(`Aucune connexion WordPress pour ${domain} : ajoutez-la dans Connexions`);
  const t = String(title ?? "").trim();
  if (t.length < 10 || t.length > 120) throw new Error("Titre de 10 à 120 caractères");
  const u = new URL(url);
  if (!hostAllowed(domain)(u.hostname)) throw new Error(`Adresse hors du site ${domain}`);
  const slug = u.pathname.split("/").filter(Boolean).pop() ?? "";
  const norm = (x: string) => x.replace(/\/$/, "");
  for (const type of ["posts", "pages"]) {
    const found = slug ? await wpFetch(wp.cfg, currentCtx(), `/${type}?slug=${encodeURIComponent(slug)}&_fields=id,link,title&status=publish`) as Row[] : [];
    const match = found.find((x) => norm(String(x.link)) === norm(url)) ?? (found.length === 1 ? found[0] : undefined);
    if (match) {
      const before = String(match.title?.rendered ?? "");
      await wpFetch(wp.cfg, currentCtx(), `/${type}/${match.id}`, { method: "POST", body: { title: t } });
      return { id: match.id, type, before, after: t, link: match.link };
    }
  }
  if (u.pathname === "/" || !slug) throw new Error("La page d'accueil se règle dans WordPress (Réglages → Général, ou votre extension SEO)");
  throw new Error("Article ou page introuvable dans WordPress pour cette adresse");
}

const siteDomain = (id: string) => (db.prepare("SELECT domain FROM sites WHERE id = ? OR domain = ?").get(id, id) as Row | undefined)?.domain as string | undefined;

export function registerCms(app: Hono) {
  app.get("/api/sites/:id/cms", (c) => {
    const d = siteDomain(c.req.param("id"));
    if (!d) return c.json({ error: "Site introuvable" }, 404);
    const wp = wordpressFor(d);
    return c.json({ wordpress: wp ? { url: wpBase(wp.cfg) } : null });
  });
  app.post("/api/sites/:id/cms/articles", async (c) => {
    if (!isAdmin(c)) return c.json({ error: "Réservé à l'administrateur" }, 403);
    const d = siteDomain(c.req.param("id"));
    if (!d) return c.json({ error: "Site introuvable" }, 404);
    try { return c.json(await publishArticle(d, await c.req.json().catch(() => ({}))), 201); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });
  app.post("/api/sites/:id/cms/fix-title", async (c) => {
    if (!isAdmin(c)) return c.json({ error: "Réservé à l'administrateur" }, 403);
    const d = siteDomain(c.req.param("id"));
    if (!d) return c.json({ error: "Site introuvable" }, 404);
    const b = await c.req.json().catch(() => ({})) as Row;
    try { return c.json(await fixTitle(d, String(b.url ?? ""), String(b.title ?? ""))); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });
}

/** Outil d'agent : brouillon seulement. La mise en ligne et les corrections passent par l'administrateur. */
export function registerCmsTools(server: McpServer) {
  server.registerTool("cms_draft", {
    description: "Crée un brouillon d'article sur le WordPress d'un site suivi (titre, contenu en texte ou Markdown léger). Rien n'est mis en ligne : l'administrateur relit et publie dans WordPress.",
    inputSchema: z.object({ site: z.string().describe("domaine du site, ex. exemple.com"), title: z.string().min(3).max(200), content: z.string().min(20).max(100_000) }),
  }, async ({ site, title, content }) => {
    const d = siteDomain(site);
    if (!d) throw new Error("Site introuvable");
    const r = await publishArticle(d, { title, content, status: "draft" });
    return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
  });
}
