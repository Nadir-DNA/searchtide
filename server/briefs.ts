// Briefs et rédaction d'articles (plan B3). Le brief se construit sans IA, à partir de Search Console (requête visée,
// requêtes voisines, questions posées, page déjà classée, pages à lier) et des pages concurrentes indiquées. Le brouillon
// est ensuite rédigé par l'IA connectée, relu par l'utilisateur, puis envoyé en brouillon dans WordPress.
import type { Hono } from "hono";
import type { McpServer } from "@modelcontextprotocol/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, type Site } from "./db.ts";
import { migrate } from "./migrations.ts";
import { isAdmin } from "./admin.ts";
import { lastDays } from "./stats.ts";
import { safeGet } from "./safe-fetch.ts";
import { clean } from "./pagecheck.ts";
import { aiConnection, complete } from "./assistant.ts";
import { publishArticle, wordpressFor } from "./cms.ts";

type Row = Record<string, any>;

migrate("2026-11-16-briefs", `CREATE TABLE briefs (id TEXT PRIMARY KEY, site_id TEXT NOT NULL, query TEXT NOT NULL, data TEXT NOT NULL,
  title TEXT, draft TEXT, status TEXT NOT NULL DEFAULT 'brief', wp_link TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);

const STOP = new Set("le la les un une des de du et en au aux pour par sur avec dans sans est que qui quoi comment pourquoi quel quelle quels quelles the a an of to for in on and or how what why with your vos votre mon ma mes son sa ses ce cet cette ces".split(" "));
export const words = (q: string) => q.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !STOP.has(w));
/** Question : un mot interrogatif au début, ou « combien / comment / pourquoi » n'importe où (« refaire toiture combien »). */
const QUESTION = /^(comment|pourquoi|quel|quelle|quels|quelles|quand|combien|où|est-ce|peut-on|faut-il|qu'est|how|what|why|which|when|can|does|do)\b|(^|\s)(combien|comment|pourquoi)(\s|$)|\?$/i;
const POS = "ROUND(SUM(position * impressions) / NULLIF(SUM(impressions), 0), 1)";

export type Competitor = { url: string; title: string | null; h1: string | null; headings: string[]; words: number; error?: string };
export type Brief = {
  query: string; position: number | null; impressions: number; clicks: number; page: string | null;
  related: { query: string; impressions: number; position: number }[]; questions: string[];
  links: { page: string; query: string }[]; competitors: Competitor[];
  outline: { title: string; h2: string[] }; length: number; generatedAt: string;
};

/** Sujets à écrire : requêtes en position 5 à 30 qui ont des impressions, sans brief encore. */
export function topicIdeas(siteId: string, days = 90, limit = 12) {
  const r = lastDays(days);
  return (db.prepare(`SELECT query, SUM(clicks) AS clicks, SUM(impressions) AS impressions, ${POS} AS position FROM gsc_rows
    WHERE site_id = ? AND day BETWEEN ? AND ? AND query <> '' GROUP BY query HAVING position BETWEEN 5 AND 30 AND impressions >= 20
    ORDER BY impressions DESC LIMIT 60`).all(siteId, r.from, r.to) as Row[])
    .filter((x) => !db.prepare("SELECT 1 FROM briefs WHERE site_id = ? AND query = ?").get(siteId, x.query)).slice(0, limit);
}

/** Structure d'une page concurrente : titre, H1, intertitres, volume de texte. */
export function pageOutline(html: string, url: string): Competitor {
  const body = html.replace(/<(script|style|noscript|nav|footer|header)\b[\s\S]*?<\/\1>/gi, " ");
  const title = clean(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "") || null;
  const h1 = clean(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(body)?.[1] ?? "") || null;
  const headings = [...body.matchAll(/<h([23])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].map((m) => `${m[1] === "3" ? "  " : ""}${clean(m[2])}`).filter((h) => h.trim()).slice(0, 40);
  const text = clean(body);
  return { url, title, h1, headings, words: text ? text.split(/\s+/).length : 0 };
}

type Fetcher = (url: string) => Promise<string>;
const fetchPage: Fetcher = async (url) => { const r = await safeGet(url, { maxBytes: 2_000_000 }); if (r.status >= 400) throw new Error(`réponse ${r.status}`); return r.body; };

export async function buildBrief(site: Site, query: string, competitorUrls: string[] = [], fetcher: Fetcher = fetchPage): Promise<Brief> {
  const q = String(query ?? "").trim().slice(0, 200);
  if (!q) throw new Error("Requête requise");
  const r = lastDays(90);
  const main = db.prepare(`SELECT SUM(clicks) AS clicks, SUM(impressions) AS impressions, ${POS} AS position FROM gsc_rows WHERE site_id = ? AND day BETWEEN ? AND ? AND query = ?`).get(site.id, r.from, r.to, q) as Row;
  const page = (db.prepare(`SELECT page FROM gsc_rows WHERE site_id = ? AND day BETWEEN ? AND ? AND query = ? AND page <> '' GROUP BY page ORDER BY SUM(impressions) DESC LIMIT 1`).get(site.id, r.from, r.to, q) as Row | undefined)?.page ?? null;
  const key = new Set(words(q));
  const candidates = db.prepare(`SELECT query, SUM(impressions) AS impressions, ${POS} AS position FROM gsc_rows WHERE site_id = ? AND day BETWEEN ? AND ? AND query <> '' AND query <> ?
    GROUP BY query ORDER BY impressions DESC LIMIT 2000`).all(site.id, r.from, r.to, q) as Row[];
  const near = candidates.filter((c) => words(c.query).some((w) => key.has(w)));
  const related = near.filter((c) => !QUESTION.test(c.query)).slice(0, 15).map((c) => ({ query: c.query, impressions: c.impressions, position: c.position }));
  const questions = near.filter((c) => QUESTION.test(c.query)).slice(0, 10).map((c) => c.query);
  // Pages du site déjà classées sur des requêtes voisines : liens internes à placer dans l'article.
  const links: { page: string; query: string }[] = [];
  for (const c of near.slice(0, 40)) {
    const p = (db.prepare(`SELECT page FROM gsc_rows WHERE site_id = ? AND day BETWEEN ? AND ? AND query = ? AND page <> '' GROUP BY page ORDER BY SUM(clicks) DESC LIMIT 1`).get(site.id, r.from, r.to, c.query) as Row | undefined)?.page;
    if (p && p !== page && !links.some((l) => l.page === p)) links.push({ page: p, query: c.query });
    if (links.length >= 5) break;
  }
  const competitors: Competitor[] = [];
  for (const raw of competitorUrls.slice(0, 5)) {
    const url = String(raw ?? "").trim(); if (!url) continue;
    try { competitors.push(pageOutline(await fetcher(url), url)); }
    catch (e) { competitors.push({ url, title: null, h1: null, headings: [], words: 0, error: (e as Error).message }); }
  }
  const measured = competitors.filter((c) => c.words > 200).map((c) => c.words).sort((a, b) => a - b);
  const median = measured.length ? measured[Math.floor(measured.length / 2)] : 0;
  const length = Math.min(Math.max(median ? Math.round(median * 1.1 / 100) * 100 : 1200, 600), 4000);
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const h2 = [...new Set([...questions.slice(0, 5).map((x) => `${cap(x)}${x.endsWith("?") ? "" : " ?"}`), ...related.slice(0, 4).map((x) => cap(x.query))])].slice(0, 8);
  return {
    query: q, position: main?.position ?? null, impressions: main?.impressions ?? 0, clicks: main?.clicks ?? 0, page,
    related, questions, links, competitors, outline: { title: cap(q), h2 }, length, generatedAt: new Date().toISOString(),
  };
}

export async function createBrief(site: Site, query: string, competitors: string[] = [], fetcher?: Fetcher) {
  const b = await buildBrief(site, query, competitors, fetcher);
  const id = randomUUID(), now = Date.now();
  db.prepare("INSERT INTO briefs (id, site_id, query, data, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, site.id, b.query, JSON.stringify(b), b.outline.title, now, now);
  return getBrief(id)!;
}
export type BriefRow = { id: string; site_id: string; query: string; title: string | null; draft: string | null; status: string; wp_link: string | null; created_at: number; updated_at: number; data: Brief };
export function getBrief(id: string): BriefRow | null {
  const r = db.prepare("SELECT * FROM briefs WHERE id = ?").get(id) as Row | undefined;
  return r ? { ...(r as Omit<BriefRow, "data">), data: JSON.parse(r.data) as Brief } : null;
}

/** Consigne de rédaction : le brief en clair, l'article en Markdown léger, sans inventer de chiffres. */
export function draftPrompt(b: Brief, domain: string) {
  return [
    `Rédige un article de blog en français pour le site ${domain}, sur la requête Google « ${b.query} ».`,
    `Longueur visée : environ ${b.length} mots.`,
    `Titre proposé : ${b.outline.title}. Tu peux l'améliorer (60 caractères au plus, avec la requête).`,
    b.outline.h2.length ? `Intertitres suggérés (à adapter) :\n${b.outline.h2.map((h) => `- ${h}`).join("\n")}` : "",
    b.questions.length ? `Questions que les internautes posent, à traiter :\n${b.questions.map((x) => `- ${x}`).join("\n")}` : "",
    b.related.length ? `Expressions voisines à employer naturellement : ${b.related.slice(0, 10).map((x) => x.query).join(", ")}.` : "",
    b.links.length ? `Liens internes à placer (Markdown [texte](adresse)) :\n${b.links.map((l) => `- ${l.page} (sujet : ${l.query})`).join("\n")}` : "",
    b.competitors.filter((c) => c.headings.length).length ? `Plans des pages concurrentes (pour couvrir le sujet au moins aussi bien, sans les copier) :\n${b.competitors.filter((c) => c.headings.length).map((c) => `${c.url}\n${c.headings.slice(0, 15).join("\n")}`).join("\n\n")}` : "",
    "Format : première ligne « # Titre », intertitres « ## », listes « - », gras **…**. Pas de chiffres, d'études ou de citations inventés : si une donnée manque, écris [à compléter].",
  ].filter(Boolean).join("\n\n");
}

export async function draftBrief(id: string, o: { connection_id?: string; fetch?: typeof fetch } = {}) {
  const b = getBrief(id);
  if (!b) throw new Error("Brief introuvable");
  const conn = aiConnection(o.connection_id);
  if (!conn) throw new Error("Aucune IA connectée : ajoutez une clé dans Connexions → Intelligence artificielle, ou rédigez vous-même à partir du brief.");
  const site = db.prepare("SELECT domain FROM sites WHERE id = ?").get(b.site_id) as Row;
  const text = await complete(conn, "Tu es un rédacteur web SEO francophone, précis et concret. Tu écris pour des lecteurs, pas pour des robots.", draftPrompt(b.data, site.domain), { fetch: o.fetch });
  if (!text) throw new Error("L'IA n'a rien renvoyé");
  const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? b.title;
  const draft = text.replace(/^#\s+.+\n+/, "").trim();
  db.prepare("UPDATE briefs SET title = ?, draft = ?, status = 'draft', updated_at = ? WHERE id = ?").run(title, draft, Date.now(), id);
  return getBrief(id)!;
}

export function saveDraft(id: string, input: { title?: string; draft?: string }) {
  const b = getBrief(id);
  if (!b) throw new Error("Brief introuvable");
  db.prepare("UPDATE briefs SET title = ?, draft = ?, status = CASE WHEN status = 'brief' AND ? <> '' THEN 'draft' ELSE status END, updated_at = ? WHERE id = ?")
    .run(String(input.title ?? b.title ?? "").slice(0, 200), String(input.draft ?? b.draft ?? ""), String(input.draft ?? ""), Date.now(), id);
  return getBrief(id)!;
}

/** Envoi dans WordPress, toujours en brouillon : la mise en ligne se fait dans WordPress après relecture. */
export async function sendToWordpress(id: string) {
  const b = getBrief(id);
  if (!b) throw new Error("Brief introuvable");
  if (!String(b.draft ?? "").trim()) throw new Error("Rédigez ou générez d'abord l'article");
  const site = db.prepare("SELECT domain FROM sites WHERE id = ?").get(b.site_id) as Row;
  const r = await publishArticle(site.domain, { title: String(b.title ?? b.query), content: String(b.draft), status: "draft" });
  db.prepare("UPDATE briefs SET status = 'sent', wp_link = ?, updated_at = ? WHERE id = ?").run(r.edit, Date.now(), id);
  return { ...getBrief(id)!, wordpress: r };
}

export function registerBriefs(app: Hono, getSite: (id: string) => Site | undefined) {
  const admin = (c: any) => isAdmin(c) ? null : c.json({ error: "Réservé à l'administrateur" }, 403);
  const wrap = (fn: (c: any) => Promise<Response> | Response) => async (c: any) => { const d = admin(c); if (d) return d; try { return await fn(c); } catch (e) { return c.json({ error: (e as Error).message }, 400); } };
  app.get("/api/sites/:id/briefs", wrap((c) => {
    const s = getSite(c.req.param("id")); if (!s) return c.json({ error: "Site introuvable" }, 404);
    const list = (db.prepare("SELECT id, query, title, status, wp_link, created_at, updated_at FROM briefs WHERE site_id = ? ORDER BY updated_at DESC").all(s.id) as Row[]);
    return c.json({ briefs: list, ideas: topicIdeas(s.id), ai: !!aiConnection(), wordpress: !!wordpressFor(s.domain) });
  }));
  app.post("/api/sites/:id/briefs", wrap(async (c) => {
    const s = getSite(c.req.param("id")); if (!s) return c.json({ error: "Site introuvable" }, 404);
    const b = await c.req.json().catch(() => ({}));
    return c.json(await createBrief(s, String(b.query ?? ""), Array.isArray(b.competitors) ? b.competitors.map(String) : []), 201);
  }));
  app.get("/api/briefs/:id", wrap((c) => { const b = getBrief(c.req.param("id")); return b ? c.json(b) : c.json({ error: "Brief introuvable" }, 404); }));
  app.put("/api/briefs/:id", wrap(async (c) => c.json(saveDraft(c.req.param("id"), await c.req.json().catch(() => ({}))))));
  app.post("/api/briefs/:id/draft", wrap(async (c) => c.json(await draftBrief(c.req.param("id"), await c.req.json().catch(() => ({}))))));
  app.post("/api/briefs/:id/wordpress", wrap(async (c) => c.json(await sendToWordpress(c.req.param("id")))));
  app.delete("/api/briefs/:id", wrap((c) => c.json({ ok: db.prepare("DELETE FROM briefs WHERE id = ?").run(c.req.param("id")).changes > 0 })));
}

/** Outils d'agent : idées de sujets et brief complet ; l'agent rédige lui-même puis crée le brouillon avec cms_draft. */
export function registerBriefTools(server: McpServer, readOnly: boolean, site: (d: string) => Site) {
  server.registerTool("brief_ideas", {
    description: "Sujets d'articles à écrire pour un site : requêtes Google en position 5 à 30 avec des impressions (90 jours), sans brief existant.",
    inputSchema: z.object({ site: z.string().describe("domaine du site") }),
  }, async ({ site: d }) => ({ content: [{ type: "text" as const, text: JSON.stringify(topicIdeas(site(d).id), null, 2) }] }));
  if (readOnly) return;
  server.registerTool("brief_create", {
    description: "Construit le brief d'un article (requête visée, requêtes voisines, questions posées, page déjà classée, liens internes, plans des pages concurrentes, longueur visée) et l'enregistre. Rédigez ensuite l'article et créez-le en brouillon avec cms_draft.",
    inputSchema: z.object({ site: z.string(), query: z.string().min(2).max(200), competitors: z.array(z.string().url()).max(5).optional().describe("adresses de pages concurrentes à analyser") }),
  }, async ({ site: d, query, competitors }) => ({ content: [{ type: "text" as const, text: JSON.stringify(await createBrief(site(d), query, competitors ?? []), null, 2) }] }));
}
