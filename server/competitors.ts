// Analyse du contenu des concurrents (plan A6) : votre page comparée à des pages concurrentes publiques — longueur, titres,
// intertitres, données structurées, images, liens, poids — puis les écarts qui comptent, en toutes lettres.
import type { Hono } from "hono";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { db, type Site } from "./db.ts";
import { migrate } from "./migrations.ts";
import { isAdmin } from "./admin.ts";
import { safeGet } from "./safe-fetch.ts";
import { clean, hostAllowed, pageUrlFor } from "./pagecheck.ts";
import { words } from "./briefs.ts";

type Row = Record<string, any>;

migrate("2026-11-17-concurrents", "CREATE TABLE site_competitors (site_id TEXT NOT NULL, url TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (site_id, url))");

export type PageFacts = {
  url: string; error?: string; status?: number; ms?: number; kb?: number;
  title: string | null; description: string | null; h1: string | null; h2: string[]; words: number;
  images: number; imagesNoAlt: number; internalLinks: number; externalLinks: number; schema: string[]; openGraph: boolean; faq: number;
};

/** Faits d'une page, à partir de son HTML. */
export function pageFacts(html: string, url: string): PageFacts {
  const host = new URL(url).hostname.replace(/^www\./, "");
  const meta = (name: string) => new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)`, "i").exec(html)?.[1]?.trim()
    ?? new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${name}["']`, "i").exec(html)?.[1]?.trim() ?? null;
  const body = html.replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, " ");
  const main = body.replace(/<(nav|footer|header)\b[\s\S]*?<\/\1>/gi, " ");
  const text = clean(main);
  const imgs = [...body.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  const links = [...main.matchAll(/<a\b[^>]*href=["']([^"'#]+)["']/gi)].map((m) => m[1]);
  let internal = 0, external = 0;
  for (const l of links) { try { const h = new URL(l, url).hostname.replace(/^www\./, ""); if (h === host) internal++; else if (/^https?:/.test(new URL(l, url).protocol)) external++; } catch { /* lien illisible */ } }
  const schema = new Set<string>();
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = (v: any): void => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") { if (v["@type"]) [].concat(v["@type"]).forEach((t) => schema.add(String(t))); if (v["@graph"]) walk(v["@graph"]); } };
      walk(JSON.parse(m[1]));
    } catch { /* JSON-LD invalide */ }
  }
  const h2 = [...main.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)].map((m) => clean(m[1])).filter(Boolean).slice(0, 40);
  return {
    url, title: clean(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "") || null, description: meta("description"),
    h1: clean(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(main)?.[1] ?? "") || null, h2, words: text ? text.split(/\s+/).length : 0,
    images: imgs.length, imagesNoAlt: imgs.filter((i) => !/\balt=["'][^"']+["']/i.test(i)).length, internalLinks: internal, externalLinks: external,
    schema: [...schema], openGraph: !!meta("og:title") && !!meta("og:image"), faq: h2.filter((h) => /\?$/.test(h)).length,
  };
}

type Fetcher = (url: string) => Promise<{ status: number; body: string; ms: number; bytes: number }>;
const fetchPage: Fetcher = (url) => safeGet(url, { maxBytes: 3_000_000 });

async function load(url: string, fetcher: Fetcher): Promise<PageFacts> {
  try {
    const r = await fetcher(url);
    if (r.status >= 400) throw new Error(`réponse ${r.status}`);
    return { ...pageFacts(r.body, url), status: r.status, ms: r.ms, kb: Math.round(r.bytes / 1024) };
  } catch (e) {
    return { url, error: (e as Error).message, title: null, description: null, h1: null, h2: [], words: 0, images: 0, imagesNoAlt: 0, internalLinks: 0, externalLinks: 0, schema: [], openGraph: false, faq: 0 };
  }
}

const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

/** Écarts entre votre page et la médiane des concurrents lisibles, du plus important au moins important. */
export function gaps(mine: PageFacts, others: PageFacts[]) {
  const ok = others.filter((o) => !o.error);
  if (mine.error || !ok.length) return [];
  const out: { level: "bad" | "warn" | "info"; text: string }[] = [];
  const w = median(ok.map((o) => o.words));
  if (w > 300 && mine.words < w * 0.7) out.push({ level: "bad", text: `Contenu plus court : ${mine.words} mots contre ${w} en médiane chez les concurrents. Développez les points qu'ils traitent.` });
  const h2 = median(ok.map((o) => o.h2.length));
  if (h2 >= 3 && mine.h2.length < h2 / 2) out.push({ level: "warn", text: `Moins structuré : ${mine.h2.length} intertitres (H2) contre ${h2} en médiane.` });
  const schemas = new Map<string, number>();
  for (const o of ok) for (const s of new Set(o.schema)) schemas.set(s, (schemas.get(s) ?? 0) + 1);
  for (const [s, n] of schemas) if (n >= Math.max(2, Math.ceil(ok.length / 2)) && !mine.schema.includes(s)) out.push({ level: "warn", text: `Données structurées « ${s} » utilisées par ${n} concurrents, absentes chez vous.` });
  if (median(ok.map((o) => o.faq)) >= 2 && mine.faq === 0) out.push({ level: "warn", text: "Les concurrents répondent à des questions en intertitres (format FAQ) ; votre page n'en a pas." });
  // Sujets présents dans les intertitres d'au moins deux concurrents et absents de votre page.
  const mineWords = new Set(words(`${mine.title ?? ""} ${mine.h1 ?? ""} ${mine.h2.join(" ")}`));
  const topic = new Map<string, Set<string>>();
  for (const o of ok) for (const w2 of new Set(words(o.h2.join(" ")))) { if (!mineWords.has(w2)) (topic.get(w2) ?? topic.set(w2, new Set()).get(w2)!).add(o.url); }
  const missing = [...topic].filter(([, s]) => s.size >= 2).sort((a, b) => b[1].size - a[1].size).slice(0, 8).map(([k]) => k);
  if (missing.length) out.push({ level: "info", text: `Sujets abordés par plusieurs concurrents et absents de vos intertitres : ${missing.join(", ")}.` });
  if (!mine.description) out.push({ level: "warn", text: "Pas de meta description : Google en fabrique une, souvent moins engageante." });
  if (mine.imagesNoAlt > 0) out.push({ level: "info", text: `${mine.imagesNoAlt} image(s) sans texte alternatif.` });
  if (mine.ms && median(ok.map((o) => o.ms ?? 0)) && mine.ms > median(ok.map((o) => o.ms ?? 0)) * 2) out.push({ level: "warn", text: `Page plus lente à répondre : ${mine.ms} ms contre ${median(ok.map((o) => o.ms ?? 0))} ms en médiane.` });
  return out;
}

export async function compare(site: Site, pageUrl: string, competitors: string[], fetcher: Fetcher = fetchPage) {
  const own = pageUrlFor(site.domain, pageUrl || "/");
  if (!hostAllowed(site.domain)(new URL(own).hostname)) throw new Error(`Adresse hors du site ${site.domain}`);
  const list = [...new Set(competitors.map((u) => String(u).trim()).filter(Boolean))].slice(0, 6);
  if (!list.length) throw new Error("Indiquez au moins une page concurrente");
  for (const u of list) { const h = new URL(u).hostname; if (hostAllowed(site.domain)(h)) throw new Error(`${u} est sur votre propre site`); }
  const [mine, ...others] = await Promise.all([own, ...list].map((u) => load(u, fetcher)));
  return { mine, competitors: others, gaps: gaps(mine, others) };
}

export const savedCompetitors = (siteId: string) => (db.prepare("SELECT url FROM site_competitors WHERE site_id = ? ORDER BY created_at").all(siteId) as Row[]).map((r) => String(r.url));
export function saveCompetitors(siteId: string, urls: string[]) {
  db.prepare("DELETE FROM site_competitors WHERE site_id = ?").run(siteId);
  for (const u of urls.slice(0, 6)) { try { new URL(u); db.prepare("INSERT OR IGNORE INTO site_competitors (site_id, url, created_at) VALUES (?, ?, ?)").run(siteId, u, Date.now()); } catch { /* adresse invalide ignorée */ } }
  return savedCompetitors(siteId);
}

export function registerCompetitors(app: Hono, getSite: (id: string) => Site | undefined) {
  app.get("/api/sites/:id/competitors", (c) => {
    const s = getSite(c.req.param("id")); if (!s) return c.json({ error: "Site introuvable" }, 404);
    return c.json({ urls: savedCompetitors(s.id) });
  });
  app.post("/api/sites/:id/competitors/compare", async (c) => {
    if (!isAdmin(c)) return c.json({ error: "Réservé à l'administrateur" }, 403);
    const s = getSite(c.req.param("id")); if (!s) return c.json({ error: "Site introuvable" }, 404);
    const b = await c.req.json().catch(() => ({}));
    const urls: string[] = Array.isArray(b.competitors) ? b.competitors.map(String) : savedCompetitors(s.id);
    try {
      const r = await compare(s, String(b.url ?? "/"), urls);
      if (Array.isArray(b.competitors)) saveCompetitors(s.id, urls);
      return c.json(r);
    } catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });
}

export function registerCompetitorTools(server: McpServer, site: (d: string) => Site) {
  server.registerTool("competitor_compare", {
    description: "Compare une page d'un site suivi à des pages concurrentes publiques : longueur, titre, intertitres, données structurées, images, liens, temps de réponse, puis les écarts à combler (sujets manquants, structure, balisage).",
    inputSchema: z.object({ site: z.string(), url: z.string().default("/").describe("chemin ou adresse de votre page"), competitors: z.array(z.string().url()).min(1).max(6).optional().describe("pages concurrentes ; sinon celles enregistrées pour le site") }),
  }, async ({ site: d, url, competitors }) => {
    const s = site(d);
    return { content: [{ type: "text" as const, text: JSON.stringify(await compare(s, url, competitors ?? savedCompetitors(s.id)), null, 2) }] };
  });
}
