// Suivi de mots-clés et diagnostics Search Console (plan A4) : requêtes suivies par site, courbe de position,
// pages qui perdent des clics, pages au taux de clic anormalement bas pour leur position, cannibalisation.
// Tout vient des données Search Console déjà importées (gsc_rows) : aucune source externe, aucun coût.
import type { Hono } from "hono";
import { db } from "./db.ts";
import { migrate } from "./migrations.ts";
import { previous, strikingDistance, type Range } from "./stats.ts";

type Row = Record<string, any>;
const all = (sql: string, ...p: (string | number)[]) => db.prepare(sql).all(...p) as Row[];

migrate("2026-11-15-mots-cles-suivis", `CREATE TABLE tracked_keywords (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  query TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, query)
)`);

// Position pondérée par les impressions, comme Search Console ; la couche (requête, page) porte le détail par mot-clé.
const POS = "ROUND(SUM(position * impressions) / NULLIF(SUM(impressions), 0), 1)";

export const normalizeQuery = (q: unknown) => String(q ?? "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 200);

export function trackKeyword(siteId: string, query: unknown, on = true) {
  const q = normalizeQuery(query);
  if (!q) throw new Error("Mot-clé vide");
  if (on) {
    const n = (db.prepare("SELECT COUNT(*) AS n FROM tracked_keywords WHERE site_id = ?").get(siteId) as Row).n as number;
    if (n >= 200) throw new Error("200 mots-clés suivis au plus par site");
    db.prepare("INSERT OR IGNORE INTO tracked_keywords (site_id, query, created_at) VALUES (?, ?, ?)").run(siteId, q, Date.now());
  } else db.prepare("DELETE FROM tracked_keywords WHERE site_id = ? AND query = ?").run(siteId, q);
  return { query: q, tracked: on };
}

const queryTotals = (siteId: string, q: string, r: Range) => all(`SELECT COALESCE(SUM(clicks), 0) AS clicks, COALESCE(SUM(impressions), 0) AS impressions,
  ${POS} AS position FROM gsc_rows WHERE site_id = ? AND query = ? AND day BETWEEN ? AND ?`, siteId, q, r.from, r.to)[0];

/** Mots-clés suivis d'un site : chiffres de la période, de la période précédente, position jour par jour et meilleure page. */
export function trackedKeywords(siteId: string, r: Range) {
  const p = previous(r);
  return all("SELECT query, created_at FROM tracked_keywords WHERE site_id = ? ORDER BY query", siteId).map((k) => {
    const now = queryTotals(siteId, k.query, r), before = queryTotals(siteId, k.query, p);
    const page = all(`SELECT page, SUM(clicks) AS clicks, SUM(impressions) AS impressions FROM gsc_rows
      WHERE site_id = ? AND query = ? AND day BETWEEN ? AND ? GROUP BY page ORDER BY clicks DESC, impressions DESC LIMIT 1`, siteId, k.query, r.from, r.to)[0];
    return {
      query: k.query, since: k.created_at,
      clicks: now.clicks, impressions: now.impressions, position: now.position,
      previous: { clicks: before.clicks, impressions: before.impressions, position: before.position },
      page: page?.page ?? null,
      series: all(`SELECT day, ${POS} AS position FROM gsc_rows WHERE site_id = ? AND query = ? AND day BETWEEN ? AND ? GROUP BY day ORDER BY day`, siteId, k.query, r.from, r.to),
    };
  });
}

/**
 * Taux de clic attendu selon la position (moyennes publiques approximatives, en %). Sert seulement à repérer
 * les pages très en dessous : l'interface le présente comme une estimation.
 */
export const EXPECTED_CTR = [0, 27, 15, 10, 7, 5.5, 4, 3, 2.5, 2, 1.8];
export const expectedCtr = (position: number) => EXPECTED_CTR[Math.min(10, Math.max(1, Math.round(position)))];

/** Diagnostics d'un site : pages qui perdent des clics, taux de clic bas pour la position, cannibalisation. */
export function seoInsights(siteId: string, r: Range) {
  const p = previous(r);
  const pages = (range: Range) => new Map(all(`SELECT page, SUM(clicks) AS clicks, SUM(impressions) AS impressions, ${POS} AS position
    FROM gsc_rows WHERE site_id = ? AND query = '' AND page <> '' AND day BETWEEN ? AND ? GROUP BY page`, siteId, range.from, range.to).map((x) => [x.page as string, x]));
  const now = pages(r), before = pages(p);

  const losing = [...before.values()].flatMap((b) => {
    const n = now.get(b.page) ?? { clicks: 0, impressions: 0, position: null };
    const lost = b.clicks - n.clicks;
    return b.clicks >= 10 && lost >= Math.max(5, b.clicks * 0.3)
      ? [{ page: b.page, clicks: n.clicks, previousClicks: b.clicks, lost, position: n.position, previousPosition: b.position }] : [];
  }).sort((a, b) => b.lost - a.lost).slice(0, 10);

  const lowCtr = [...now.values()].flatMap((x) => {
    if (x.position == null || x.position > 10 || x.impressions < 100) return [];
    const ctr = (100 * x.clicks) / x.impressions, expected = expectedCtr(x.position);
    return ctr < expected * 0.5 ? [{ page: x.page, impressions: x.impressions, clicks: x.clicks, position: x.position, ctr: Math.round(ctr * 100) / 100, expected }] : [];
  }).sort((a, b) => b.impressions * (b.expected - b.ctr) - a.impressions * (a.expected - a.ctr)).slice(0, 10);

  // Cannibalisation : une requête qui fait apparaître au moins deux pages, chacune avec 20 % ou plus de ses impressions.
  const rows = all(`SELECT query, page, SUM(clicks) AS clicks, SUM(impressions) AS impressions, ${POS} AS position FROM gsc_rows
    WHERE site_id = ? AND query <> '' AND day BETWEEN ? AND ? AND query IN (
      SELECT query FROM gsc_rows WHERE site_id = ? AND query <> '' AND day BETWEEN ? AND ? GROUP BY query HAVING SUM(impressions) >= 50 ORDER BY SUM(impressions) DESC LIMIT 300)
    GROUP BY query, page`, siteId, r.from, r.to, siteId, r.from, r.to);
  const byQuery = new Map<string, Row[]>();
  for (const x of rows) byQuery.set(x.query, [...(byQuery.get(x.query) ?? []), x]);
  const cannibal = [...byQuery].flatMap(([query, list]) => {
    const total = list.reduce((n, x) => n + x.impressions, 0);
    const shared = list.filter((x) => x.impressions >= total * 0.2).sort((a, b) => b.impressions - a.impressions);
    return shared.length >= 2 ? [{ query, impressions: total, pages: shared.map((x) => ({ page: x.page, impressions: x.impressions, clicks: x.clicks, position: x.position })) }] : [];
  }).sort((a, b) => b.impressions - a.impressions).slice(0, 10);

  return { range: r, losing, lowCtr, cannibal };
}

/** Mots-clés suivis qui reculent d'au moins 3 places sur 7 jours (avec un minimum d'impressions pour éviter le bruit). */
export function keywordDrops(siteId: string, r: Range) {
  return trackedKeywords(siteId, r).filter((k) => k.position != null && k.previous.position != null && k.impressions >= 10 && k.position - k.previous.position >= 3);
}

/** Suggestions : mots-clés en position 4 à 20 pas encore suivis. */
export function keywordSuggestions(siteId: string, r: Range, limit = 10) {
  const tracked = new Set(all("SELECT query FROM tracked_keywords WHERE site_id = ?", siteId).map((x) => x.query));
  return (strikingDistance(siteId, r, 50) as Row[]).filter((x) => !tracked.has(x.query)).slice(0, limit);
}

/** Routes REST. La portée des clés d'agent est appliquée en amont (projectForPath sur /api/sites/:id). */
export function registerKeywords(app: Hono, getSite: (id: string) => { id: string } | undefined, rangeOf: (c: any) => Range) {
  app.get("/api/sites/:id/keywords", (c) => {
    const s = getSite(c.req.param("id"));
    if (!s) return c.json({ error: "Site introuvable" }, 404);
    const r = rangeOf(c);
    return c.json({ range: r, tracked: trackedKeywords(s.id, r), suggestions: keywordSuggestions(s.id, r) });
  });
  app.post("/api/sites/:id/keywords", async (c) => {
    const s = getSite(c.req.param("id"));
    if (!s) return c.json({ error: "Site introuvable" }, 404);
    const b = await c.req.json().catch(() => ({})) as Row;
    try { return c.json(trackKeyword(s.id, b.query, b.tracked !== false)); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });
  app.get("/api/sites/:id/seo-insights", (c) => {
    const s = getSite(c.req.param("id"));
    return s ? c.json(seoInsights(s.id, rangeOf(c))) : c.json({ error: "Site introuvable" }, 404);
  });
}
