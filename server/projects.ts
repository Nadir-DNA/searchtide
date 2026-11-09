// Projets et indicateurs : chaque projet regroupe ses sites, ses contacts, ses publications et ses chiffres clés,
// relevés chaque jour depuis leur source (base Postgres, Stripe, adresse web, site suivi ou saisie à la main).
// Les secrets ne sont jamais en base : un indicateur nomme la variable d'environnement qui les contient.
import type { Hono } from "hono";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { db, localDay } from "./db.ts";
import { lastDays, previous, type Range } from "./stats.ts";
import { migrate } from "./migrations.ts";
import { collectVia } from "./connectors/use.ts";
import { realCtx } from "./connectors/registry.ts";
import { stripeMetric } from "./connectors/stripe.ts";
import { googleToken } from "./gsc.ts";

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT,
  url TEXT,
  sites TEXT NOT NULL DEFAULT '[]',   -- domaines suivis rattachés au projet
  crm_key TEXT,                       -- valeur du champ « projet » des contacts et publications
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS indicators (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  unit TEXT,                          -- « € », « % »…
  mode TEXT NOT NULL,                 -- daily : un chiffre par jour, additionné | total : un niveau (abonnés, clients actifs)
  source TEXT NOT NULL,               -- pg | stripe | http | site | manual
  config TEXT NOT NULL DEFAULT '{}',
  position INTEGER NOT NULL DEFAULT 0,
  last_run INTEGER, last_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS metrics (
  indicator_id TEXT NOT NULL REFERENCES indicators(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  value REAL NOT NULL,
  PRIMARY KEY (indicator_id, day)
);
`);

migrate("2026-11-09-objectifs-entonnoirs-reperes", `
ALTER TABLE indicators ADD COLUMN goal REAL;
ALTER TABLE indicators ADD COLUMN goal_period TEXT;
ALTER TABLE projects ADD COLUMN funnel TEXT NOT NULL DEFAULT '[]';
CREATE TABLE annotations (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,  -- NULL : visible sur tous les projets
  day TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX annotations_day ON annotations(day);
`);

type Row = Record<string, any>;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = (t: number) => new Date(t).toISOString().slice(0, 10);
const days = (r: Range) => { const out: string[] = []; for (let t = Date.parse(r.from); t <= Date.parse(r.to); t += 86400000) out.push(day(t)); return out; };
const ENV = /^[A-Z][A-Z0-9_]*$/;

const configs = {
  pg: z.object({ env: z.string().regex(ENV), sql: z.string().min(1).max(4000) }),
  stripe: z.object({ env: z.string().regex(ENV).optional(), connection_id: z.string().optional(), metric: z.enum(["revenue", "new_customers", "active_subscriptions", "mrr"]), account: z.string().regex(/^acct_\w+$/).optional() }),
  http: z.object({ url: z.string().url(), path: z.string().max(200).default(""), env: z.string().regex(ENV).optional() }),
  site: z.object({ domain: z.string(), metric: z.enum(["visitors", "pageviews", "clicks", "impressions"]) }),
  manual: z.object({}),
  pagespeed: z.object({ url: z.string().url(), metric: z.enum(["performance", "seo", "lcp", "cls"]), strategy: z.enum(["mobile", "desktop"]).default("mobile"), env: z.string().regex(ENV).default("PAGESPEED_KEY") }),
  play: z.object({ env: z.string().regex(ENV).default("PLAY_BUCKET"), package: z.string().regex(/^[a-z][a-z0-9_.]+$/), metric: z.enum(["daily_installs", "active_installs", "rating"]) }),
};
export type Source = keyof typeof configs;
const indicatorFields = z.object({
  label: z.string().trim().min(1).max(100),
  unit: z.string().trim().max(10).nullish().transform((v) => v || null),
  mode: z.enum(["daily", "total"]),
  source: z.enum(["pg", "stripe", "http", "site", "manual", "pagespeed", "play"]),
  config: z.record(z.string(), z.unknown()).default({}),
  position: z.number().int().default(0),
  goal: z.number().finite().positive().nullish().transform((v) => v ?? null),
  goal_period: z.enum(["week", "month"]).nullish().transform((v) => v ?? null),
}).superRefine((v, ctx) => {
  const r = configs[v.source].safeParse(v.config);
  if (!r.success) ctx.addIssue({ code: "custom", path: ["config"], message: r.error.issues.map((i) => `${i.path.join(".")} : ${i.message}`).join(", ") });
});
const projectFields = z.object({
  name: z.string().trim().min(1).max(100),
  color: z.string().regex(/^#[0-9a-f]{6}$/i).nullish().transform((v) => v || null),
  url: z.string().url().nullish().or(z.literal("")).transform((v) => v || null),
  sites: z.array(z.string()).default([]),
  crm_key: z.string().trim().max(50).nullish().transform((v) => v || null),
  position: z.number().int().default(0),
  funnel: z.array(z.string()).max(8).default([]),   // indicateurs dans l'ordre de l'entonnoir
});

const decodeInd = (r: Row): Row => ({ ...r, config: JSON.parse(r.config) });
const decodeProj = (r: Row): Row => ({ ...r, sites: JSON.parse(r.sites), funnel: JSON.parse(r.funnel ?? "[]") });
const getInd = (id: string) => { const r = db.prepare("SELECT * FROM indicators WHERE id = ?").get(id) as Row | undefined; return r && decodeInd(r); };

// ── Connecteurs ──
const secret = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`Variable ${name} absente du fichier .env`);
  return v;
};
const pools = new Map<string, pg.Pool>();
function pool(env: string) {
  if (!pools.has(env)) pools.set(env, new pg.Pool({ connectionString: secret(env), max: 2, idleTimeoutMillis: 30_000, statement_timeout: 15_000, ssl: /sslmode=require|supabase/.test(secret(env)) ? { rejectUnauthorized: false } : undefined }));
  return pools.get(env)!;
}
async function pgValue(c: z.infer<typeof configs.pg>, d?: string) {
  if (!/^\s*(select|with)\b/i.test(c.sql)) throw new Error("Seules les requêtes SELECT sont acceptées");
  const client = await pool(c.env).connect();
  try {
    // Lecture seule imposée côté base, en plus du rôle limité conseillé
    await client.query("BEGIN READ ONLY");
    const res = await client.query(c.sql, c.sql.includes("$1") ? [d] : []);
    await client.query("ROLLBACK");
    const v = Number(Object.values(res.rows[0] ?? {})[0] ?? 0);
    if (!Number.isFinite(v)) throw new Error("La requête doit renvoyer un nombre");
    return v;
  } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; } finally { client.release(); }
}

export { parisMidnight, monthlyNet } from "./connectors/stripe.ts";

async function stripeValue(c: z.infer<typeof configs.stripe>, d?: string) {
  // Ancien mode : un indicateur qui désigne une variable d'environnement la garde (clé d'organisation sk_org_ comprise)
  if (c.env) return stripeMetric({ key: secret(c.env), account: c.account }, c.metric, d, realCtx());
  // Sinon : la connexion enregistrée dans l'interface (clé restreinte déchiffrée à la demande, aucun Stripe-Account)
  return collectVia("stripe", c.connection_id, c.metric, {}, d);
}

async function httpValue(c: z.infer<typeof configs.http>) {
  const res = await fetch(c.url, { headers: c.env ? { Authorization: `Bearer ${secret(c.env)}` } : {}, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const v = Number(c.path ? c.path.split(".").reduce((o: any, k) => o?.[k], j) : j);
  if (!Number.isFinite(v)) throw new Error(`Pas de nombre à « ${c.path || "la racine"} »`);
  return v;
}

// PageSpeed Insights : note sur 100 ou mesure Core Web Vitals (secondes pour le LCP), une fois par jour
async function pagespeedValue(c: z.infer<typeof configs.pagespeed>) {
  const q = new URLSearchParams({ url: c.url, strategy: c.strategy, key: secret(c.env) });
  q.append("category", "performance"); q.append("category", "seo");
  const res = await fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${q}`, { signal: AbortSignal.timeout(120_000) });
  const j = await res.json() as Row;
  if (!res.ok) throw new Error(`PageSpeed ${res.status} : ${j.error?.message?.slice(0, 200) ?? "erreur"}`);
  const l = j.lighthouseResult;
  if (c.metric === "performance" || c.metric === "seo") return Math.round(l.categories[c.metric].score * 100);
  if (c.metric === "lcp") return Math.round(l.audits["largest-contentful-paint"].numericValue / 10) / 100;
  return Math.round(l.audits["cumulative-layout-shift"].numericValue * 1000) / 1000;
}

// Google Play : rapports CSV mensuels déposés par la Play Console dans son espace Cloud Storage (UTF-16)
async function playCsv(bucket: string, object: string) {
  const res = await fetch(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}?alt=media`,
    { headers: { Authorization: `Bearer ${await googleToken("https://www.googleapis.com/auth/devstorage.read_only")}` } });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`Google Play ${res.status} : ${(await res.text()).slice(0, 200)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf[0] === 0xff && buf[1] === 0xfe ? buf.subarray(2).toString("utf16le") : buf.toString("utf8");
  const [head, ...lines] = text.split(/\r?\n/).filter((l) => l.trim());
  const cols = head.split(",").map((x) => x.trim());
  return lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [cols[i], v.trim()])));
}
async function playValue(c: z.infer<typeof configs.play>, d?: string) {
  const bucket = secret(c.env).replace(/^gs:\/\//, "").replace(/\/.*$/, "");
  const month = (d ?? localDay()).slice(0, 7).replace("-", "");
  const kind = c.metric === "rating" ? "ratings" : "installs";
  let rows = await playCsv(bucket, `stats/${kind}/${kind}_${c.package}_${month}_overview.csv`);
  if (!rows.length && !d) { // début de mois : rapport pas encore publié, on lit le mois précédent
    const prev = new Date(Date.UTC(+month.slice(0, 4), +month.slice(4) - 2, 1)).toISOString().slice(0, 7).replace("-", "");
    rows = await playCsv(bucket, `stats/${kind}/${kind}_${c.package}_${prev}_overview.csv`);
  }
  if (!rows.length) throw new Error("Aucun rapport Google Play pour ce mois (vérifiez le nom du paquet et l'accès du compte de service)");
  const col = c.metric === "rating" ? "Total Average Rating" : c.metric === "active_installs" ? "Active Device Installs" : "Daily User Installs";
  const row = d ? rows.find((r) => r.Date === d) : rows.at(-1);
  return row ? Number(row[col]) || 0 : 0;
}

/** Série d'un site suivi, calculée à la lecture depuis les tables existantes. */
function siteSeries(c: z.infer<typeof configs.site>, r: Range): Record<string, number> {
  const s = db.prepare("SELECT id FROM sites WHERE domain = ?").get(c.domain) as Row | undefined;
  if (!s) return {};
  const rows = c.metric === "visitors" || c.metric === "pageviews"
    ? db.prepare(`SELECT day, ${c.metric === "visitors" ? "COUNT(DISTINCT visitor)" : "COUNT(*)"} AS v FROM events WHERE site_id = ? AND type = 'pageview' AND day BETWEEN ? AND ? GROUP BY day`).all(s.id, r.from, r.to)
    : db.prepare(`SELECT day, SUM(${c.metric}) AS v FROM gsc_rows WHERE site_id = ? AND query = '' AND page = '' AND day BETWEEN ? AND ? GROUP BY day`).all(s.id, r.from, r.to);
  return Object.fromEntries((rows as Row[]).map((x) => [x.day, x.v]));
}

/** Valeur d'un indicateur pour un jour (indicateurs journaliers) ou maintenant (niveaux). */
export async function measure(ind: Row, d = localDay()) {
  const at = ind.mode === "daily" ? d : undefined;
  switch (ind.source) {
    case "pg": return pgValue(configs.pg.parse(ind.config), at);
    case "stripe": return stripeValue(configs.stripe.parse(ind.config), at);
    case "http": return httpValue(configs.http.parse(ind.config));
    case "site": return siteSeries(configs.site.parse(ind.config), { from: d, to: d })[d] ?? 0;
    case "pagespeed": return pagespeedValue(configs.pagespeed.parse(ind.config));
    case "play": return playValue(configs.play.parse(ind.config), at);
    default: throw new Error("Indicateur saisi à la main : rien à relever");
  }
}
const canBackfill = (ind: Row) => ind.mode === "daily" && (ind.source === "stripe" ? ind.config.metric === "revenue" || ind.config.metric === "new_customers"
  : ind.source === "play" || (ind.source === "pg" && ind.config.sql.includes("$1")));

const upsert = db.prepare("INSERT INTO metrics (indicator_id, day, value) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET value = excluded.value");
export function record(id: string, d: string, value: number) { upsert.run(id, d, value); }

/** Relève un indicateur : hier et aujourd'hui pour un chiffre journalier (ou `backfill` jours), aujourd'hui pour un niveau. */
export async function collect(ind: Row, backfill = 0) {
  if (ind.source === "manual" || ind.source === "site") return { values: 0 };
  const today = localDay();
  const targets = canBackfill(ind) ? days({ from: day(Date.now() - Math.max(backfill, 1) * 86400000), to: today }) : [today];
  let values = 0;
  try {
    for (const d of targets) { record(ind.id, d, await measure(ind, d)); values++; }
    db.prepare("UPDATE indicators SET last_run = ?, last_error = NULL WHERE id = ?").run(Date.now(), ind.id);
  } catch (e) {
    db.prepare("UPDATE indicators SET last_run = ?, last_error = ? WHERE id = ?").run(Date.now(), (e as Error).message.slice(0, 500), ind.id);
    throw e;
  }
  return { values };
}
export async function collectAll() {
  for (const r of db.prepare("SELECT * FROM indicators WHERE source NOT IN ('manual', 'site')").all() as Row[]) {
    // PageSpeed et Google Play changent au plus une fois par jour : inutile d'interroger plus souvent
    if ((r.source === "pagespeed" || r.source === "play") && r.last_run && !r.last_error && Date.now() - r.last_run < 20 * 3600 * 1000) continue;
    await collect(decodeInd(r)).catch((e) => console.error(`[indicateurs] ${r.label} :`, e.message));
  }
}

// ── Lecture : valeur sur la période, période précédente et série pour les courbes ──
export function indicatorView(ind: Row, r: Range) {
  const p = previous(r);
  const span = { from: p.from, to: r.to };
  const stored = ind.source === "site" ? siteSeries(ind.config, span)
    : Object.fromEntries((db.prepare("SELECT day, value FROM metrics WHERE indicator_id = ? AND day BETWEEN ? AND ?").all(ind.id, span.from, span.to) as Row[]).map((x) => [x.day, x.value]));
  const series = days(r).map((d) => ({ day: d, value: stored[d] ?? null }));
  let value: number | null, before: number | null;
  if (ind.mode === "daily") {
    const sum = (rr: Range) => { const v = days(rr).map((d) => stored[d]).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) : null; };
    value = sum(r); before = sum(p);
  } else {
    // Niveau : dernière valeur connue, comparée à la dernière connue avant le début de la période
    const last = (to: string) => (db.prepare("SELECT value FROM metrics WHERE indicator_id = ? AND day <= ? ORDER BY day DESC LIMIT 1").get(ind.id, to) as Row | undefined)?.value ?? null;
    value = last(r.to); before = last(p.to);
  }
  return { id: ind.id, label: ind.label, unit: ind.unit, mode: ind.mode, source: ind.source, config: ind.config, position: ind.position,
    last_run: ind.last_run, last_error: ind.last_error, value, previous: before, series, goal: goalProgress(ind) };
}

/** Avancement vers l'objectif de la semaine ou du mois en cours, avec projection au rythme actuel. */
export function goalProgress(ind: Row, now = new Date()) {
  if (!ind.goal) return null;
  const today = localDay(now);
  const t = Date.parse(today);
  const dow = (new Date(t).getUTCDay() + 6) % 7;
  const from = ind.goal_period === "week" ? day(t - dow * 86400000) : today.slice(0, 8) + "01";
  const total = ind.goal_period === "week" ? 7 : new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7), 0)).getUTCDate();
  const elapsed = Math.round((t - Date.parse(from)) / 86400000) + 1;
  let done: number;
  if (ind.mode === "daily") {
    const stored = ind.source === "site" ? siteSeries(ind.config, { from, to: today })
      : Object.fromEntries((db.prepare("SELECT day, value FROM metrics WHERE indicator_id = ? AND day BETWEEN ? AND ?").all(ind.id, from, today) as Row[]).map((x) => [x.day, x.value]));
    done = Object.values(stored).reduce((a: number, b) => a + Number(b), 0);
  } else done = (db.prepare("SELECT value FROM metrics WHERE indicator_id = ? ORDER BY day DESC LIMIT 1").get(ind.id) as Row | undefined)?.value ?? 0;
  const projection = ind.mode === "daily" ? (done / elapsed) * total : done;
  return { target: ind.goal, period: ind.goal_period, from, done, projection: Math.round(projection * 100) / 100, pct: Math.round((done / ind.goal) * 1000) / 10, elapsed, total };
}

export function listProjects(r: Range): Row[] {
  return (db.prepare("SELECT * FROM projects ORDER BY position, name").all() as Row[]).map((p) => {
    const proj = decodeProj(p);
    const indicators = (db.prepare("SELECT * FROM indicators WHERE project_id = ? ORDER BY position, created_at").all(p.id) as Row[]).map((i) => indicatorView(decodeInd(i), r));
    // Entonnoir : chaque étape avec son taux de passage depuis l'étape précédente
    const steps = (proj.funnel as string[]).map((id) => indicators.find((i) => i.id === id)).filter(Boolean) as Row[];
    const funnel = steps.map((s, k) => ({ id: s.id, label: s.label, value: s.value,
      rate: k && steps[k - 1].value ? Math.round((s.value ?? 0) / steps[k - 1].value * 1000) / 10 : null }));
    return { ...proj, indicators, funnel };
  });
}
export function getProject(id: string, r: Range) {
  return listProjects(r).find((p) => p.id === id || p.crm_key === id) ?? null;
}

export function saveProject(id: string | null, input: unknown) {
  const cur = id ? db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row | undefined : undefined;
  if (id && !cur) return null;
  const v = projectFields.parse({ ...(cur && decodeProj(cur)), ...(input as Row) });
  const pid = id ?? randomUUID();
  db.prepare(`INSERT INTO projects (id, name, color, url, sites, crm_key, position, funnel, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, color = excluded.color, url = excluded.url, sites = excluded.sites, crm_key = excluded.crm_key, position = excluded.position, funnel = excluded.funnel`)
    .run(pid, v.name, v.color, v.url, JSON.stringify(v.sites), v.crm_key, v.position, JSON.stringify(v.funnel), cur?.created_at ?? Date.now());
  return decodeProj(db.prepare("SELECT * FROM projects WHERE id = ?").get(pid) as Row);
}
export function saveIndicator(id: string | null, projectId: string | null, input: unknown) {
  const cur = id ? getInd(id) : undefined;
  if (id && !cur) return null;
  const v = indicatorFields.parse({ ...cur, ...(input as Row) });
  const iid = id ?? randomUUID();
  db.prepare(`INSERT INTO indicators (id, project_id, label, unit, mode, source, config, position, goal, goal_period, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET label = excluded.label, unit = excluded.unit, mode = excluded.mode, source = excluded.source, config = excluded.config,
    position = excluded.position, goal = excluded.goal, goal_period = excluded.goal_period`)
    .run(iid, cur?.project_id ?? projectId, v.label, v.unit, v.mode, v.source, JSON.stringify(v.config), v.position, v.goal, v.goal ? v.goal_period ?? "month" : null, cur?.created_at ?? Date.now());
  // Changer la source ou la requête rend l'historique faux
  if (cur && (cur.source !== v.source || JSON.stringify(cur.config) !== JSON.stringify(v.config))) db.prepare("DELETE FROM metrics WHERE indicator_id = ?").run(iid);
  return getInd(iid)!;
}

export function annotations(projectId: string | undefined, r: Range) {
  const p = projectId ? db.prepare("SELECT id, crm_key FROM projects WHERE id = ?").get(projectId) as Row | undefined : undefined;
  const notes = db.prepare(`SELECT id, day, label, 'note' AS kind FROM annotations WHERE day BETWEEN ? AND ? ${p ? "AND (project_id = ? OR project_id IS NULL)" : ""}`)
    .all(...[r.from, r.to, ...(p ? [p.id] : [])]) as Row[];
  const pubs = db.prepare(`SELECT id, day, title AS label, 'publication' AS kind FROM publications WHERE status = 'published' AND day BETWEEN ? AND ? ${p?.crm_key ? "AND project = ?" : p ? "AND 0" : ""}`)
    .all(...[r.from, r.to, ...(p?.crm_key ? [p.crm_key] : [])]) as Row[];
  return [...notes, ...pubs].sort((a, b) => a.day.localeCompare(b.day));
}

export const rangeOf = (q: Record<string, string>): Range =>
  DAY.test(q.from ?? "") && DAY.test(q.to ?? "") ? { from: q.from, to: q.to } : lastDays(Math.min(Math.max(Number(q.days) || 28, 1), 500));

export function registerProjects(app: Hono) {
  const bad = (e: unknown) => e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")} : ${i.message}`).join(", ") : (e as Error).message;

  app.get("/api/projects", (c) => c.json(listProjects(rangeOf(c.req.query()))));
  app.get("/api/projects/:id", (c) => { const p = getProject(c.req.param("id"), rangeOf(c.req.query())); return p ? c.json(p) : c.json({ error: "Projet introuvable" }, 404); });
  app.post("/api/projects", async (c) => { try { return c.json(saveProject(null, await c.req.json()), 201); } catch (e) { return c.json({ error: bad(e) }, 400); } });
  app.patch("/api/projects/:id", async (c) => {
    try { const p = saveProject(c.req.param("id"), await c.req.json()); return p ? c.json(p) : c.json({ error: "Projet introuvable" }, 404); } catch (e) { return c.json({ error: bad(e) }, 400); }
  });
  app.delete("/api/projects/:id", (c) => db.prepare("DELETE FROM projects WHERE id = ?").run(c.req.param("id")).changes ? c.json({ ok: true }) : c.json({ error: "Projet introuvable" }, 404));

  app.post("/api/projects/:id/indicators", async (c) => {
    if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(c.req.param("id"))) return c.json({ error: "Projet introuvable" }, 404);
    try {
      const ind = saveIndicator(null, c.req.param("id"), await c.req.json())!;
      await collect(ind, 90).catch(() => {}); // l'erreur éventuelle reste visible sur l'indicateur
      return c.json(getInd(ind.id), 201);
    } catch (e) { return c.json({ error: bad(e) }, 400); }
  });
  app.patch("/api/indicators/:id", async (c) => {
    try {
      const ind = saveIndicator(c.req.param("id"), null, await c.req.json());
      if (!ind) return c.json({ error: "Indicateur introuvable" }, 404);
      await collect(ind, 90).catch(() => {});
      return c.json(getInd(ind.id));
    } catch (e) { return c.json({ error: bad(e) }, 400); }
  });
  app.delete("/api/indicators/:id", (c) => db.prepare("DELETE FROM indicators WHERE id = ?").run(c.req.param("id")).changes ? c.json({ ok: true }) : c.json({ error: "Indicateur introuvable" }, 404));
  // Essai sans rien enregistrer, pour mettre au point une requête
  app.post("/api/indicators/test", async (c) => {
    try {
      const b = await c.req.json();
      const v = indicatorFields.parse({ label: "essai", ...b });
      return c.json({ value: await measure(v) });
    } catch (e) { return c.json({ error: bad(e) }, 400); }
  });
  app.post("/api/indicators/:id/collect", async (c) => {
    const ind = getInd(c.req.param("id"));
    if (!ind) return c.json({ error: "Indicateur introuvable" }, 404);
    try { return c.json(await collect(ind, Number(c.req.query("days")) || 1)); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });
  app.post("/api/indicators/:id/value", async (c) => {
    const ind = getInd(c.req.param("id"));
    if (!ind) return c.json({ error: "Indicateur introuvable" }, 404);
    const b = await c.req.json().catch(() => ({}));
    const d = DAY.test(b.day ?? "") ? b.day : localDay();
    if (!Number.isFinite(Number(b.value)) || b.value === "" || b.value == null) return c.json({ error: "Valeur invalide" }, 400);
    record(ind.id, d, Number(b.value));
    return c.json({ ok: true, day: d });
  });

  // Repères des courbes : notes datées et publications du projet
  app.get("/api/annotations", (c) => c.json(annotations(c.req.query("project"), rangeOf(c.req.query()))));
  app.post("/api/annotations", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    if (!DAY.test(b.day ?? "") || typeof b.label !== "string" || !b.label.trim()) return c.json({ error: "Date (AAAA-MM-JJ) et texte requis" }, 400);
    const id = randomUUID();
    db.prepare("INSERT INTO annotations (id, project_id, day, label, created_at) VALUES (?, ?, ?, ?, ?)").run(id, b.project_id || null, b.day, b.label.trim().slice(0, 200), Date.now());
    return c.json({ id }, 201);
  });
  app.delete("/api/annotations/:id", (c) => db.prepare("DELETE FROM annotations WHERE id = ?").run(c.req.param("id")).changes ? c.json({ ok: true }) : c.json({ error: "Repère introuvable" }, 404));

  // Relevé au démarrage puis toutes les 3 h
  setTimeout(() => void collectAll(), 20_000);
  setInterval(() => void collectAll(), 3 * 3600 * 1000).unref();
}

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
export function registerProjectTools(server: McpServer, readOnly = false) {
  server.registerTool("projects_kpis", {
    description: "Tous les projets avec leurs indicateurs clés (valeur sur la période, période précédente) : inscriptions, ventes, revenus, visiteurs…",
    inputSchema: z.object({ days: z.number().int().min(1).max(500).default(28) }),
  }, async ({ days }) => json(listProjects(lastDays(days)).map((p) => ({ name: p.name, crm_key: p.crm_key, sites: p.sites,
    indicators: p.indicators.map((i: Record<string, any>) => ({ id: i.id, label: i.label, unit: i.unit, mode: i.mode, value: i.value, previous: i.previous, error: i.last_error })) }))));
  if (!readOnly) server.registerTool("indicator_record", {
    description: "Enregistre à la main la valeur d'un indicateur pour un jour (ex. abonnés TikTok). Donne l'id obtenu avec projects_kpis.",
    inputSchema: z.object({ id: z.string(), value: z.number(), day: z.string().regex(DAY).optional() }),
  }, async ({ id, value, day: d }) => { if (!getInd(id)) return json({ error: "Indicateur introuvable" }); record(id, d ?? localDay(), value); return json({ ok: true }); });
}
