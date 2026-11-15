// Indexation (plan A5) : état d'indexation par page lu chez Google (API d'inspection d'URL de Search Console)
// et signalement des pages nouvelles ou modifiées par IndexNow (Bing, Yandex, Seznam, Naver…).
// Google n'ouvre pas d'API d'indexation générale : on lit son état, on ne promet pas une indexation immédiate.
import type { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { db } from "./db.ts";
import { migrate } from "./migrations.ts";
import { registerJob } from "./jobs.ts";
import { currentCtx } from "./connectors/use.ts";
import { googleToken, gscConfigured, gscPropertyFor } from "./gsc.ts";
import { safeGet } from "./safe-fetch.ts";
import { hostAllowed } from "./pagecheck.ts";

type Row = Record<string, any>;
type Site = { id: string; domain: string };

migrate("2026-11-15-indexation", `
CREATE TABLE indexing_pages (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  lastmod TEXT,
  verdict TEXT,            -- PASS (indexée) | PARTIAL | FAIL | NEUTRAL, selon Google
  coverage TEXT,           -- texte de Google, ex. « Explorée, actuellement non indexée »
  last_crawl TEXT,
  inspected_at INTEGER,
  error TEXT,
  submitted_at INTEGER,    -- dernier envoi IndexNow
  PRIMARY KEY (site_id, url)
);
CREATE TABLE indexnow_keys (
  site_id TEXT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  verified_at INTEGER,
  last_submit INTEGER,
  last_result TEXT
);`);

const MAX_URLS = 5000;
const INSPECT_PER_RUN = 50;          // le quota Google est quotidien et par propriété : on reste très en dessous
const REINSPECT_AFTER = 7 * 86_400_000;

/** Adresses et dates d'un sitemap (ou d'un index de sitemaps). */
export function parseSitemap(xml: string): { index: boolean; entries: { loc: string; lastmod: string | null }[] } {
  const index = /<sitemapindex\b/i.test(xml);
  const entries = [...xml.matchAll(/<(?:url|sitemap)\b[^>]*>([\s\S]*?)<\/(?:url|sitemap)>/gi)].map((m) => ({
    loc: (/<loc>\s*([^<\s]+)\s*<\/loc>/i.exec(m[1])?.[1] ?? "").replace(/&amp;/g, "&"),
    lastmod: /<lastmod>\s*([^<\s]+)\s*<\/lastmod>/i.exec(m[1])?.[1] ?? null,
  })).filter((e) => e.loc);
  return { index, entries };
}

const upsertPage = db.prepare(`INSERT INTO indexing_pages (site_id, url, lastmod) VALUES (?, ?, ?)
  ON CONFLICT(site_id, url) DO UPDATE SET lastmod = COALESCE(excluded.lastmod, lastmod)`);

/** Liste des pages du site : sitemap (index suivi sur 10 sitemaps au plus) et pages connues de Search Console. */
export async function discoverPages(site: Site): Promise<{ added: number; sitemap: string | null; error?: string }> {
  const allow = (u: URL) => hostAllowed(site.domain)(u.hostname);
  const before = (db.prepare("SELECT COUNT(*) AS n FROM indexing_pages WHERE site_id = ?").get(site.id) as Row).n as number;
  let sitemap: string | null = null, error: string | undefined;
  try {
    const robots = await safeGet(`https://${site.domain}/robots.txt`, { allow, maxBytes: 512_000 }).catch(() => null);
    sitemap = robots?.status === 200 ? (/^\s*sitemap\s*:\s*(\S+)/im.exec(robots.body)?.[1] ?? null) : null;
    const first = await safeGet(sitemap ?? `https://${site.domain}/sitemap.xml`, { allow, maxBytes: 10_000_000 });
    if (first.status !== 200) throw new Error(`sitemap introuvable (${first.status})`);
    sitemap = first.url;
    let parsed = parseSitemap(first.body);
    const urls = parsed.index ? [] : parsed.entries;
    if (parsed.index) for (const child of parsed.entries.slice(0, 10)) {
      const r = await safeGet(child.loc, { allow, maxBytes: 10_000_000 }).catch(() => null);
      if (r?.status === 200) { parsed = parseSitemap(r.body); urls.push(...parsed.entries); }
      if (urls.length >= MAX_URLS) break;
    }
    db.exec("BEGIN");
    for (const u of urls.slice(0, MAX_URLS)) if (allow(new URL(u.loc))) upsertPage.run(site.id, u.loc, u.lastmod);
    db.exec("COMMIT");
  } catch (e) { if (db.isTransaction) db.exec("ROLLBACK"); error = (e as Error).message; }
  // Pages vues par Google ces 90 derniers jours (couche par page de Search Console)
  const known = db.prepare(`SELECT DISTINCT page FROM gsc_rows WHERE site_id = ? AND query = '' AND page <> '' AND day >= date('now', '-90 day') LIMIT ?`).all(site.id, MAX_URLS) as Row[];
  for (const k of known) upsertPage.run(site.id, k.page, null);
  const after = (db.prepare("SELECT COUNT(*) AS n FROM indexing_pages WHERE site_id = ?").get(site.id) as Row).n as number;
  return { added: after - before, sitemap, error };
}

/** Inspecte quelques pages chez Google : jamais inspectées d'abord, puis les plus anciennes (au-delà de 7 jours). */
export async function inspectBatch(site: Site, limit = INSPECT_PER_RUN, now = Date.now()) {
  const property = gscPropertyFor(site.domain);
  if (!gscConfigured() || !property) throw new Error("Reliez ce site à Search Console pour lire son état d'indexation chez Google");
  return inspectWith(site, property, await googleToken(), limit, now);
}

/** Inspection d'un lot avec une propriété et un jeton donnés (séparé pour les tests). */
export async function inspectWith(site: Site, property: string, token: string, limit = INSPECT_PER_RUN, now = Date.now()) {
  const pages = db.prepare(`SELECT url FROM indexing_pages WHERE site_id = ? AND (inspected_at IS NULL OR inspected_at < ?)
    ORDER BY inspected_at IS NOT NULL, inspected_at LIMIT ?`).all(site.id, now - REINSPECT_AFTER, limit) as Row[];
  let done = 0, failed = 0;
  for (const p of pages) {
    const res = await currentCtx().fetch("https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ inspectionUrl: p.url, siteUrl: property, languageCode: "fr" }),
    });
    const data = await res.json().catch(() => ({})) as any;
    if (res.status === 429) break;   // quota du jour atteint : on reprendra demain
    if (!res.ok) {
      failed++;
      db.prepare("UPDATE indexing_pages SET inspected_at = ?, error = ? WHERE site_id = ? AND url = ?").run(now, `Google ${res.status} : ${data.error?.message ?? "erreur"}`.slice(0, 300), site.id, p.url);
      continue;
    }
    const r = data.inspectionResult?.indexStatusResult ?? {};
    db.prepare("UPDATE indexing_pages SET verdict = ?, coverage = ?, last_crawl = ?, inspected_at = ?, error = NULL WHERE site_id = ? AND url = ?")
      .run(r.verdict ?? null, r.coverageState ?? null, r.lastCrawlTime ?? null, now, site.id, p.url);
    done++;
  }
  return { inspected: done, failed, remaining: Math.max(0, pages.length - done - failed) };
}

// ── IndexNow ──
export function indexnowKey(siteId: string, create = false): Row | null {
  const k = db.prepare("SELECT * FROM indexnow_keys WHERE site_id = ?").get(siteId) as Row | undefined;
  if (k || !create) return k ?? null;
  db.prepare("INSERT INTO indexnow_keys (site_id, key) VALUES (?, ?)").run(siteId, randomBytes(16).toString("hex"));
  return db.prepare("SELECT * FROM indexnow_keys WHERE site_id = ?").get(siteId) as Row;
}

/** Le fichier de clé doit être publié sur le site : https://domaine/<clé>.txt, contenant la clé. */
export async function verifyIndexnow(site: Site) {
  const k = indexnowKey(site.id, true)!;
  const url = `https://${site.domain}/${k.key}.txt`;
  const r = await safeGet(url, { allow: (u) => hostAllowed(site.domain)(u.hostname), maxBytes: 4096 }).catch((e) => ({ status: 0, body: String((e as Error).message) }));
  const ok = r.status === 200 && r.body.trim() === k.key;
  db.prepare("UPDATE indexnow_keys SET verified_at = ? WHERE site_id = ?").run(ok ? Date.now() : null, site.id);
  return { ok, url, message: ok ? "Fichier de clé trouvé" : r.status === 200 ? "Le fichier existe mais ne contient pas la clé" : `Fichier introuvable (${r.status || r.body})` };
}

/** Pages à signaler : jamais envoyées, ou modifiées (lastmod) depuis le dernier envoi. */
export function pagesToSubmit(siteId: string, limit = 1000): string[] {
  return (db.prepare(`SELECT url FROM indexing_pages WHERE site_id = ? AND (submitted_at IS NULL OR (lastmod IS NOT NULL AND lastmod > strftime('%Y-%m-%dT%H:%M:%S', submitted_at / 1000, 'unixepoch')))
    ORDER BY lastmod DESC LIMIT ?`).all(siteId, limit) as Row[]).map((r) => r.url);
}

export async function submitIndexnow(site: Site, urls?: string[]) {
  const k = indexnowKey(site.id);
  if (!k?.verified_at) throw new Error("Publiez d'abord le fichier de clé IndexNow sur le site, puis vérifiez-le");
  const allow = hostAllowed(site.domain);
  const list = [...new Set((urls?.length ? urls : pagesToSubmit(site.id)).filter((u) => { try { return allow(new URL(u).hostname); } catch { return false; } }))].slice(0, 10_000);
  if (!list.length) return { submitted: 0, status: 0, message: "Aucune page nouvelle ou modifiée à signaler" };
  const res = await currentCtx().fetch("https://api.indexnow.org/indexnow", {
    method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ host: site.domain, key: k.key, keyLocation: `https://${site.domain}/${k.key}.txt`, urlList: list }),
  });
  const messages: Record<number, string> = { 200: "Pages signalées", 202: "Pages reçues, clé en cours de vérification", 400: "Requête refusée", 403: "Clé refusée : le fichier de clé n'est plus en ligne", 422: "Adresses refusées (hors du domaine ?)", 429: "Trop d'envois : réessayez plus tard" };
  const ok = res.status === 200 || res.status === 202;
  const message = messages[res.status] ?? `Réponse ${res.status}`;
  if (ok) {
    const now = Date.now();
    db.exec("BEGIN");
    for (const u of list) db.prepare("INSERT INTO indexing_pages (site_id, url, submitted_at) VALUES (?, ?, ?) ON CONFLICT(site_id, url) DO UPDATE SET submitted_at = excluded.submitted_at").run(site.id, u, now);
    db.exec("COMMIT");
  }
  db.prepare("UPDATE indexnow_keys SET last_submit = ?, last_result = ? WHERE site_id = ?").run(Date.now(), message, site.id);
  if (!ok) throw new Error(`IndexNow : ${message}`);
  return { submitted: list.length, status: res.status, message };
}

/** Résumé pour l'écran et les agents. */
export function indexingStatus(siteId: string) {
  const c = db.prepare(`SELECT COUNT(*) AS total, SUM(verdict = 'PASS') AS indexed, SUM(verdict IS NOT NULL AND verdict <> 'PASS') AS not_indexed,
    SUM(verdict IS NULL) AS unknown, SUM(submitted_at IS NOT NULL) AS submitted FROM indexing_pages WHERE site_id = ?`).get(siteId) as Row;
  const k = indexnowKey(siteId);
  return {
    total: c.total ?? 0, indexed: c.indexed ?? 0, notIndexed: c.not_indexed ?? 0, unknown: c.unknown ?? 0, submitted: c.submitted ?? 0,
    pending: pagesToSubmit(siteId, 10_000).length,
    problems: db.prepare(`SELECT url, verdict, coverage, last_crawl, inspected_at, error FROM indexing_pages WHERE site_id = ? AND ((verdict IS NOT NULL AND verdict <> 'PASS') OR error IS NOT NULL)
      ORDER BY inspected_at DESC LIMIT 50`).all(siteId),
    indexnow: k ? { key: k.key, file: `${k.key}.txt`, verified: !!k.verified_at, lastSubmit: k.last_submit, lastResult: k.last_result } : null,
  };
}

/** Tâche quotidienne : découverte des pages, IndexNow pour les pages nouvelles ou modifiées, inspection Google d'un lot. */
export function registerIndexingJobs() {
  registerJob("analytics", { id: "indexation", every: "24h", run: async () => {
    const sites = db.prepare("SELECT id, domain FROM sites").all() as Site[];
    for (const s of sites) {
      const watched = indexnowKey(s.id)?.verified_at || gscPropertyFor(s.domain);
      if (!watched) continue;
      await discoverPages(s);
      if (indexnowKey(s.id)?.verified_at) await submitIndexnow(s).catch((e) => console.error(`[indexation] ${s.domain} :`, (e as Error).message));
      if (gscConfigured() && gscPropertyFor(s.domain)) await inspectBatch(s).catch((e) => console.error(`[indexation] ${s.domain} :`, (e as Error).message));
    }
  } });
}

export function registerIndexing(app: Hono, getSite: (id: string) => Site | undefined) {
  const withSite = (fn: (s: Site, c: any) => Promise<Response> | Response) => async (c: any) => {
    const s = getSite(c.req.param("id"));
    if (!s) return c.json({ error: "Site introuvable" }, 404);
    try { return await fn(s, c); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
  };
  app.get("/api/sites/:id/indexing", withSite((s, c) => c.json(indexingStatus(s.id))));
  app.post("/api/sites/:id/indexing/refresh", withSite(async (s, c) => {
    const found = await discoverPages(s);
    const google = gscConfigured() && gscPropertyFor(s.domain) ? await inspectBatch(s, 20) : null;
    return c.json({ found, google, status: indexingStatus(s.id) });
  }));
  app.post("/api/sites/:id/indexnow/verify", withSite(async (s, c) => c.json(await verifyIndexnow(s))));
  app.post("/api/sites/:id/indexnow/submit", withSite(async (s, c) => {
    const b = await c.req.json().catch(() => ({})) as Row;
    return c.json(await submitIndexnow(s, Array.isArray(b.urls) ? b.urls.map(String) : undefined));
  }));
}
