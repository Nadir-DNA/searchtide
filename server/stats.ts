import { db } from "./db.ts";

export type Range = { from: string; to: string }; // AAAA-MM-JJ inclus

const all = (sql: string, ...p: (string | number)[]) => db.prepare(sql).all(...p) as Record<string, any>[];

function top(siteId: string, r: Range, col: string, limit = 10) {
  return all(`SELECT ${col} AS key, COUNT(DISTINCT visitor) AS visitors, COUNT(*) AS pageviews
    FROM events WHERE site_id = ? AND day BETWEEN ? AND ? AND type = 'pageview' AND ${col} IS NOT NULL
    GROUP BY ${col} ORDER BY visitors DESC LIMIT ${limit}`, siteId, r.from, r.to);
}

/** La période de même durée juste avant, pour les comparaisons. */
export function previous(r: Range): Range {
  const span = Date.parse(r.to) - Date.parse(r.from) + 86400000;
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  return { from: day(Date.parse(r.from) - span), to: day(Date.parse(r.from) - 86400000) };
}

const trafficTotals = (siteId: string, r: Range) => ({ ...all(`SELECT COUNT(DISTINCT visitor || day) AS visitors,
  COUNT(*) AS pageviews, COUNT(DISTINCT CASE WHEN channel = 'ai' THEN visitor || day END) AS ai
  FROM events WHERE site_id = ? AND day BETWEEN ? AND ? AND type = 'pageview'`, siteId, r.from, r.to)[0] });

/** Statistiques de trafic d'un site sur une période. */
export function trafficStats(siteId: string, r: Range) {
  return {
    range: r,
    totals: trafficTotals(siteId, r),
    previous: trafficTotals(siteId, previous(r)),
    daily: all(`SELECT day, COUNT(DISTINCT visitor) AS visitors, COUNT(*) AS pageviews FROM events
      WHERE site_id = ? AND day BETWEEN ? AND ? AND type = 'pageview' GROUP BY day ORDER BY day`, siteId, r.from, r.to),
    pages: top(siteId, r, "path"),
    channels: top(siteId, r, "channel"),
    referrers: top(siteId, r, "referrer"),
    countries: top(siteId, r, "country"),
    devices: top(siteId, r, "device"),
    browsers: top(siteId, r, "browser"),
    campaigns: top(siteId, r, "utm_campaign"),
    aiReferrers: all(`SELECT referrer AS key, COUNT(DISTINCT visitor) AS visitors, COUNT(*) AS pageviews FROM events
      WHERE site_id = ? AND day BETWEEN ? AND ? AND channel = 'ai' GROUP BY referrer ORDER BY visitors DESC`, siteId, r.from, r.to),
    events: all(`SELECT name AS key, COUNT(*) AS count FROM events WHERE site_id = ? AND day BETWEEN ? AND ?
      AND type = 'event' GROUP BY name ORDER BY count DESC LIMIT 20`, siteId, r.from, r.to),
  };
}

// Position moyenne pondérée par les impressions, comme dans Search Console
const POS = "ROUND(SUM(position * impressions) / NULLIF(SUM(impressions), 0), 1)";
const CTR = "ROUND(100.0 * SUM(clicks) / NULLIF(SUM(impressions), 0), 2)";

const searchTotals = (siteId: string, r: Range) => ({ ...all(`SELECT COALESCE(SUM(clicks), 0) AS clicks,
  COALESCE(SUM(impressions), 0) AS impressions, ${CTR} AS ctr, ${POS} AS position
  FROM gsc_rows WHERE site_id = ? AND day BETWEEN ? AND ? AND query = '' AND page = ''`, siteId, r.from, r.to)[0] });

/** Statistiques Search Console d'un site sur une période. */
export function searchStats(siteId: string, r: Range, limit = 50) {
  const w = "site_id = ? AND day BETWEEN ? AND ?";
  const p = previous(r);
  return {
    range: r,
    totals: searchTotals(siteId, r),
    previous: searchTotals(siteId, p),
    daily: all(`SELECT day, SUM(clicks) AS clicks, SUM(impressions) AS impressions, ${POS} AS position
      FROM gsc_rows WHERE ${w} AND query = '' AND page = '' GROUP BY day ORDER BY day`, siteId, r.from, r.to),
    queries: all(`SELECT query, SUM(clicks) AS clicks, SUM(impressions) AS impressions, ${CTR} AS ctr, ${POS} AS position
      FROM gsc_rows WHERE ${w} AND query <> '' GROUP BY query ORDER BY clicks DESC, impressions DESC LIMIT ${limit}`, siteId, r.from, r.to),
    pages: all(`SELECT page, SUM(clicks) AS clicks, SUM(impressions) AS impressions, ${CTR} AS ctr, ${POS} AS position
      FROM gsc_rows WHERE ${w} AND query = '' AND page <> '' GROUP BY page ORDER BY clicks DESC, impressions DESC LIMIT ${limit}`, siteId, r.from, r.to),
  };
}

/** Mots-clés en position 4 à 20 avec des impressions : les plus faciles à faire monter en première page. */
export function strikingDistance(siteId: string, r: Range, limit = 30) {
  return all(`SELECT query, SUM(clicks) AS clicks, SUM(impressions) AS impressions, ${POS} AS position
    FROM gsc_rows WHERE site_id = ? AND day BETWEEN ? AND ? AND query <> '' GROUP BY query
    HAVING position BETWEEN 4 AND 20 ORDER BY impressions DESC LIMIT ${limit}`, siteId, r.from, r.to);
}

/** Vue d'ensemble : un résumé par site, avec la période précédente. */
export function overview(r: Range) {
  const p = previous(r);
  const daily = all(`SELECT day, COUNT(DISTINCT site_id || visitor) AS visitors FROM events
    WHERE day BETWEEN ? AND ? AND type = 'pageview' GROUP BY day ORDER BY day`, r.from, r.to);
  const sites = (db.prepare("SELECT id, domain, name, gsc_property FROM sites ORDER BY domain").all() as Record<string, any>[]).map((s) => ({
    ...s, traffic: trafficTotals(s.id, r), trafficPrev: trafficTotals(s.id, p),
    search: s.gsc_property ? searchTotals(s.id, r) : null,
    today: (db.prepare("SELECT COUNT(DISTINCT visitor) AS n FROM events WHERE site_id = ? AND day = ? AND type = 'pageview'")
      .get(s.id, new Date().toISOString().slice(0, 10)) as { n: number }).n,
  }));
  return { range: r, daily, sites };
}

export function lastDays(n: number, end = new Date()): Range {
  const to = end.toISOString().slice(0, 10);
  const from = new Date(end.getTime() - (n - 1) * 86400000).toISOString().slice(0, 10);
  return { from, to };
}
