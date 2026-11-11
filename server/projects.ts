// Projets et indicateurs : chaque projet regroupe ses sites, ses contacts, ses publications et ses chiffres clés,
// relevés chaque jour depuis leur source (base Postgres, Stripe, adresse web, site suivi ou saisie à la main).
// Les secrets ne sont jamais en base : un indicateur nomme la variable d'environnement qui les contient.
import type { Hono } from "hono";
import { registerJob } from "./jobs.ts";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { db, localDay } from "./db.ts";
import { lastDays, previous, type Range } from "./stats.ts";
import { migrate } from "./migrations.ts";
import { hiddenIndicators, indicatorModule, isEnabled, setEnabled, setProjectModule } from "./modules/state.ts";
import { isAdmin } from "./admin.ts";
import { SECRET_CONFIG_ERROR, SECRET_REFS, hasSecretKey, hasUrlSecret, maskSecrets, maskUrlSecrets } from "./mask.ts";
import { shouldMaskConfig } from "./viewer.ts";
import { canAccess, visibleProjectIds } from "./agents.ts";
import { consumeApproval } from "./approvals.ts";
import { securityEvent } from "./security-events.ts";
import { snapshotBeforeDelete } from "./security.ts";
import { getModule } from "./modules/index.ts";
import { collectVia, currentCtx } from "./connectors/use.ts";
import { connections } from "./connections.ts";
import { stripeMetric } from "./connectors/stripe.ts";
import { checkSql, pgQuery } from "./connectors/postgres.ts";
import { pagespeedMetric } from "./connectors/pagespeed.ts";
import { pickNumber } from "./connectors/jsonapi.ts";
import { serviceAccount } from "./gsc.ts";
import { playMetric } from "./connectors/google.ts";

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

migrate("2026-11-10-favoris", "ALTER TABLE projects ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
migrate("2026-11-10-jalons", "ALTER TABLE annotations ADD COLUMN milestone INTEGER NOT NULL DEFAULT 0; ALTER TABLE annotations ADD COLUMN source TEXT NOT NULL DEFAULT 'manuel';");

// P1-A : l'ancienne série d'un indicateur dont la source change est conservée en indicateur archivé.
export const ARCHIVE_MIGRATION = `ALTER TABLE indicators ADD COLUMN archived_at INTEGER;
ALTER TABLE indicators ADD COLUMN archived_from TEXT;`;
migrate("2026-11-11-indicateurs-archives", ARCHIVE_MIGRATION);

// Journal des modifications d'indicateur : interface, clé/agent ou module ; valeurs sensibles masquées.
migrate("2026-11-11-fraicheur", `ALTER TABLE projects ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;
ALTER TABLE indicators ADD COLUMN stale_after_days INTEGER;`);
migrate("2026-11-11-journal-indicateurs", `CREATE TABLE indicator_changes (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, indicator_id TEXT NOT NULL,
  actor TEXT NOT NULL, field TEXT NOT NULL, before TEXT, after TEXT
)`);
function masked(value: unknown): string {
  if (value == null) return "";
  let obj: unknown = value;
  try { if (typeof value === "string") obj = JSON.parse(value); } catch { return String(value).slice(0, 500); }
  return JSON.stringify(maskSecrets(obj)).slice(0, 500);
}
function logIndicatorChange(indicatorId: string, actor: string, field: string, before: unknown, after: unknown) {
  const b = masked(before), a = masked(after);
  if (b === a) return;
  db.prepare("INSERT INTO indicator_changes (ts, indicator_id, actor, field, before, after) VALUES (?, ?, ?, ?, ?, ?)")
    .run(Date.now(), indicatorId, actor, field, b, a);
}

type Row = Record<string, any>;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = (t: number) => new Date(t).toISOString().slice(0, 10);
const days = (r: Range) => { const out: string[] = []; for (let t = Date.parse(r.from); t <= Date.parse(r.to); t += 86400000) out.push(day(t)); return out; };
const ENV = /^[A-Z][A-Z0-9_]*$/;
/** Variables qui contiennent les propres secrets de Searchtide : jamais lisibles par un indicateur (sinon un agent pourrait les envoyer à une adresse de son choix). */
export const RESERVED_ENV = new Set(["SECRET", "ADMIN_PASSWORD", "API_KEY", "API_KEY_READ", "TOTP_SECRET", "INBOUND_KEY", "SMTP_URL", "BACKUP_TOKEN", "GOOGLE_SERVICE_ACCOUNT_JSON"]);
const envName = z.string().regex(ENV).refine((n) => !RESERVED_ENV.has(n), "Variable réservée à Searchtide : choisissez une connexion ou une autre variable");

const configs = {
  pg: z.object({ env: envName.optional(), connection_id: z.string().optional(), sql: z.string().min(1).max(4000) })
    .superRefine((v, ctx) => { try { checkSql(v.sql); } catch (e) { ctx.addIssue({ code: "custom", path: ["sql"], message: (e as Error).message }); } }),
  supabase: z.object({ metric: z.enum(["users_total", "signups_on", "signed_in", "db_size_bytes"]), days: z.number().int().min(1).max(365).optional(), connection_id: z.string().optional() }),
  stripe: z.object({ env: envName.optional(), connection_id: z.string().optional(), metric: z.enum(["revenue", "new_customers", "active_subscriptions", "mrr"]), account: z.string().regex(/^acct_\w+$/).optional() }),
  http: z.object({ url: z.string().url(), path: z.string().max(200).default(""), env: envName.optional(), connection_id: z.string().optional() }),
  site: z.object({ domain: z.string(), metric: z.enum(["visitors", "pageviews", "clicks", "impressions", "ai_visitors", "event"]), event: z.string().min(1).max(80).optional() })
    .refine((c) => c.metric !== "event" || c.event, "Nom de l'événement requis"),
  manual: z.object({ role: z.enum(["revenue", "contacts"]).optional() }),
  pagespeed: z.object({ url: z.string().url(), metric: z.enum(["performance", "seo", "lcp", "cls"]), strategy: z.enum(["mobile", "desktop"]).default("mobile"), env: envName.optional(), connection_id: z.string().optional() }),
  play: z.object({ env: envName.optional(), connection_id: z.string().optional(), package: z.string().regex(/^[a-z][a-z0-9_.]+$/), metric: z.enum(["daily_installs", "active_installs", "rating"]) }),
  // KPI calculé : premier terme, puis chaque terme appliqué par son opération, le tout multiplié par scale (100 pour un %)
  formula: z.object({ terms: z.array(z.object({ indicator: z.string().min(1), op: z.enum(["+", "-", "*", "/"]) })).min(2).max(6), scale: z.number().finite().positive().optional() }),
};
export type Source = keyof typeof configs;
const indicatorFields = z.object({
  label: z.string().trim().min(1).max(100),
  unit: z.string().trim().max(10).nullish().transform((v) => v || null),
  mode: z.enum(["daily", "total"]),
  source: z.enum(["pg", "supabase", "stripe", "http", "site", "manual", "pagespeed", "play", "formula"]),
  config: z.record(z.string(), z.unknown()).default({}),
  position: z.number().int().default(0),
  goal: z.number().finite().positive().nullish().transform((v) => v ?? null),
  goal_period: z.enum(["week", "month"]).nullish().transform((v) => v ?? null),
  stale_after_days: z.number().int().min(1).max(365).nullish().transform((v) => v ?? null),
});
const projectFields = z.object({
  name: z.string().trim().min(1).max(100),
  color: z.string().regex(/^#[0-9a-f]{6}$/i).nullish().transform((v) => v || null),
  url: z.string().url().nullish().or(z.literal("")).transform((v) => v || null),
  sites: z.array(z.string()).default([]),
  crm_key: z.string().trim().max(50).nullish().transform((v) => v || null),
  position: z.number().int().default(0),
  funnel: z.array(z.string()).max(8).default([]),   // indicateurs dans l'ordre de l'entonnoir
  pinned: z.boolean().default(false),               // favori : toujours visible dans le menu
  paused: z.boolean().default(false),               // projet en pause : aucune alerte de fraîcheur
});

const decodeInd = (r: Row): Row => ({ ...r, config: JSON.parse(r.config) });
const decodeProj = (r: Row): Row => ({ ...r, sites: JSON.parse(r.sites), funnel: JSON.parse(r.funnel ?? "[]"), pinned: !!r.pinned, paused: !!r.paused });
const getInd = (id: string) => { const r = db.prepare("SELECT * FROM indicators WHERE id = ?").get(id) as Row | undefined; return r && decodeInd(r); };

// ── Connecteurs ──
const secret = (name: string) => {
  if (RESERVED_ENV.has(name)) throw new Error(`La variable ${name} est réservée à Searchtide : choisissez une connexion ou une autre variable.`);
  const v = process.env[name];
  if (!v) throw new Error(`Variable ${name} absente du fichier .env`);
  return v;
};
// Postgres : par la connexion « Postgres (lecture seule) », ou, ancien mode, par la variable d'environnement qui contient l'URL
// (config.env). Dans les deux cas : une seule requête SELECT, en lecture seule imposée, 10 s au plus (connectors/postgres.ts).
async function pgValue(c: z.infer<typeof configs.pg>, mode: string, d?: string) {
  if (c.env) return pgQuery(secret(c.env), c.sql, d, currentCtx());
  return collectVia("postgres", c.connection_id, mode === "daily" ? "sql_daily" : "sql_total", { sql: c.sql }, d);
}

export { parisMidnight, monthlyNet } from "./connectors/stripe.ts";

async function stripeValue(c: z.infer<typeof configs.stripe>, d?: string) {
  // Ancien mode : un indicateur qui désigne une variable d'environnement la garde (clé d'organisation sk_org_ comprise)
  if (c.env) return stripeMetric({ key: secret(c.env), account: c.account }, c.metric, d, currentCtx());
  // Sinon : la connexion enregistrée dans l'interface (clé restreinte déchiffrée à la demande, aucun Stripe-Account)
  return collectVia("stripe", c.connection_id, c.metric, {}, d);
}

// API JSON : par une connexion « API JSON » (jeton envoyé au seul domaine autorisé), ou, ancien mode, par une adresse libre
// avec un jeton facultatif dans une variable d'environnement (config.env).
async function httpValue(c: z.infer<typeof configs.http>) {
  if (c.connection_id && !c.env) return collectVia("jsonapi", c.connection_id, "json_total", { url: c.url, path: c.path }, undefined); // une variable explicite l'emporte (CA20)
  const res = await currentCtx().fetch(c.url, { headers: c.env ? { Authorization: `Bearer ${secret(c.env)}` } : {}, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return pickNumber(await res.json(), c.path);
}

// PageSpeed Insights : par la connexion PageSpeed (clé facultative), ou, ancien mode, par la variable d'environnement
// qui contient la clé (config.env, défaut PAGESPEED_KEY quand aucune connexion n'existe).
async function pagespeedValue(c: z.infer<typeof configs.pagespeed>) {
  if (!c.env && (c.connection_id || connections("pagespeed").length)) return collectVia("pagespeed", c.connection_id, c.metric, { url: c.url, strategy: c.strategy }, undefined);
  return pagespeedMetric({ url: c.url, metric: c.metric, strategy: c.strategy, key: secret(c.env ?? "PAGESPEED_KEY") }, currentCtx());
}

// Google Play : par la connexion Google (bucket renseigné dans la connexion), ou, ancien mode, par la variable d'environnement
// qui contient le bucket (config.env, défaut PLAY_BUCKET) avec GOOGLE_SERVICE_ACCOUNT_JSON.
async function playValue(c: z.infer<typeof configs.play>, d?: string) {
  if (!c.env && (c.connection_id || connections("google").length)) return collectVia("google", c.connection_id, c.metric, { package: c.package }, d);
  const bucket = secret(c.env ?? "PLAY_BUCKET");
  const sa = serviceAccount();
  if (!sa) throw new Error("Google n'est pas connecté : ajoutez Google dans Connexions");
  return playMetric({ sa, bucket, pkg: c.package, metric: c.metric, day: d, today: localDay() }, currentCtx());
}

/** Série d'un site suivi, calculée à la lecture depuis les tables existantes. */
function siteSeries(c: z.infer<typeof configs.site>, r: Range): Record<string, number> {
  const s = db.prepare("SELECT id FROM sites WHERE domain = ?").get(c.domain) as Row | undefined;
  if (!s) return {};
  const rows = c.metric === "visitors" || c.metric === "pageviews"
    ? db.prepare(`SELECT day, ${c.metric === "visitors" ? "COUNT(DISTINCT visitor)" : "COUNT(*)"} AS v FROM events WHERE site_id = ? AND type = 'pageview' AND day BETWEEN ? AND ? GROUP BY day`).all(s.id, r.from, r.to)
    : c.metric === "ai_visitors"
    ? db.prepare("SELECT day, COUNT(DISTINCT visitor) AS v FROM events WHERE site_id = ? AND type = 'pageview' AND channel = 'ai' AND day BETWEEN ? AND ? GROUP BY day").all(s.id, r.from, r.to)
    : c.metric === "event"
    ? db.prepare("SELECT day, COUNT(*) AS v FROM events WHERE site_id = ? AND type = 'event' AND name = ? AND day BETWEEN ? AND ? GROUP BY day").all(s.id, c.event!, r.from, r.to)
    : db.prepare(`SELECT day, SUM(${c.metric}) AS v FROM gsc_rows WHERE site_id = ? AND query = '' AND page = '' AND day BETWEEN ? AND ? GROUP BY day`).all(s.id, r.from, r.to);
  return Object.fromEntries((rows as Row[]).map((x) => [x.day, x.v]));
}

/** Valeur d'un indicateur pour un jour (indicateurs journaliers) ou maintenant (niveaux). */
export async function measure(ind: Row, d = localDay()) {
  const at = ind.mode === "daily" ? d : undefined;
  switch (ind.source) {
    case "pg": return pgValue(configs.pg.parse(ind.config), ind.mode, at);
    case "supabase": return collectVia("supabase", ind.config.connection_id, ind.config.metric, { days: ind.config.days }, at);
    case "stripe": return stripeValue(configs.stripe.parse(ind.config), at);
    case "http": return httpValue(configs.http.parse(ind.config));
    case "site": return siteSeries(configs.site.parse(ind.config), { from: d, to: d })[d] ?? 0;
    case "pagespeed": return pagespeedValue(configs.pagespeed.parse(ind.config));
    case "play": return playValue(configs.play.parse(ind.config), at);
    case "formula": { const v = formulaSeries(configs.formula.parse(ind.config), ind.project_id, { from: d, to: d })[d]; if (v == null) throw new Error("Pas de valeur calculable ce jour-là"); return v; }
    default: throw new Error("Indicateur saisi à la main : rien à relever");
  }
}
const canBackfill = (ind: Row) => ind.mode === "daily" && (ind.source === "stripe" ? ind.config.metric === "revenue" || ind.config.metric === "new_customers"
  : ind.source === "play" || ind.source === "supabase" || (ind.source === "pg" && ind.config.sql.includes("$1")));

const upsert = db.prepare("INSERT INTO metrics (indicator_id, day, value) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET value = excluded.value");
export function record(id: string, d: string, value: number) { upsert.run(id, d, value); }

/** Relève un indicateur : hier et aujourd'hui pour un chiffre journalier (ou `backfill` jours), aujourd'hui pour un niveau. */
export async function collect(ind: Row, backfill = 0) {
  if (ind.archived_at) throw new Error("Série archivée : non relevée");
  if (ind.source === "manual" || ind.source === "site" || ind.source === "formula") return { values: 0 };
  const today = localDay();
  const targets = canBackfill(ind) ? days({ from: day(Date.now() - Math.max(backfill, 1) * 86400000), to: today }) : [today];
  let values = 0;
  try {
    for (const d of targets) { record(ind.id, d, await measure(ind, d)); values++; }
    db.prepare("UPDATE indicators SET last_run = ?, last_error = NULL WHERE id = ?").run(Date.now(), ind.id);
  } catch (e) {
    db.prepare("UPDATE indicators SET last_run = ?, last_error = ? WHERE id = ?").run(Date.now(), maskUrlSecrets((e as Error).message).slice(0, 500), ind.id);
    throw e;
  }
  return { values };
}
export async function collectAll() {
  for (const r of db.prepare("SELECT * FROM indicators WHERE archived_at IS NULL AND source NOT IN ('manual', 'site', 'formula')").all() as Row[]) {
    // PageSpeed et Google Play changent au plus une fois par jour : inutile d'interroger plus souvent
    if ((r.source === "pagespeed" || r.source === "play") && r.last_run && !r.last_error && Date.now() - r.last_run < 20 * 3600 * 1000) continue;
    await collect(decodeInd(r)).catch((e) => console.error(`[indicateurs] ${r.label} :`, e.message));
  }
}

// ── KPI calculés ──
export type Formula = { terms: { indicator: string; op: "+" | "-" | "*" | "/" }[]; scale?: number };
function checkTerms(f: Formula, projectId: string, self: string) {
  for (const t of f.terms) {
    const o = db.prepare("SELECT project_id, source FROM indicators WHERE id = ?").get(t.indicator) as Row | undefined;
    if (!o) throw new Error(`Indicateur « ${t.indicator} » introuvable`);
    if (o.project_id !== projectId) throw new Error("Une formule ne peut citer qu'un indicateur de son projet, pas d'un autre projet.");
    if (o.source === "formula" || t.indicator === self) throw new Error("Une formule ne peut pas citer une autre formule.");
  }
}
const apply = (terms: Formula["terms"], vals: (number | null)[], scale = 1): number | null => {
  let acc = vals[0];
  for (let i = 1; i < terms.length && acc != null; i++) {
    const v = vals[i];
    if (v == null) return null;
    const op = terms[i].op;
    if (op === "/" && v === 0) return null;
    acc = op === "+" ? acc + v : op === "-" ? acc - v : op === "*" ? acc * v : acc / v;
  }
  return acc == null ? null : Math.round(acc * scale * 10000) / 10000;
};
/** Opérandes d'une formule ; null et le nom de l'indicateur manquant si l'un a disparu. */
function operands(f: Formula): { rows: Row[]; missing: string | null } {
  const rows: Row[] = [];
  for (const t of f.terms) {
    const r = db.prepare("SELECT * FROM indicators WHERE id = ?").get(t.indicator) as Row | undefined;
    if (!r) return { rows: [], missing: t.indicator };
    rows.push(decodeInd(r));
  }
  return { rows, missing: null };
}
const storedSeries = (ind: Row, span: Range): Record<string, number> => ind.source === "site" ? siteSeries(ind.config, span)
  : Object.fromEntries((db.prepare("SELECT day, value FROM metrics WHERE indicator_id = ? AND day BETWEEN ? AND ?").all(ind.id, span.from, span.to) as Row[]).map((x) => [x.day, x.value]));

/** Valeur jour par jour : un terme sans valeur ce jour-là, ou une division par zéro, donne null. */
export function formulaSeries(cfg: Formula, _projectId: string, r: Range): Record<string, number | null> {
  const { rows, missing } = operands(cfg);
  if (missing) return Object.fromEntries(days(r).map((d) => [d, null]));
  const series = rows.map((o) => storedSeries(o, r));
  return Object.fromEntries(days(r).map((d) => [d, apply(cfg.terms, series.map((x) => x[d] ?? null), cfg.scale)]));
}

function formulaView(ind: Row, r: Range): ReturnType<typeof plainView> {
  const cfg = ind.config as Formula;
  const { rows, missing } = operands(cfg);
  const error = missing ? `Indicateur « ${missing} » introuvable` : null;
  if (error !== (ind.last_error ?? null)) db.prepare("UPDATE indicators SET last_error = ? WHERE id = ?").run(maskUrlSecrets(error ?? ""), ind.id);
  const s = formulaSeries(cfg, ind.project_id, r);
  // Sur une période, la formule s'applique aux valeurs de période de chaque terme (5 inscriptions / 150 visites), pas à la somme des jours
  const period = (rr: Range): number | null => missing ? null : apply(cfg.terms, rows.map((o) => indicatorView(o, rr).value), cfg.scale);
  return { id: ind.id, label: ind.label, unit: ind.unit, mode: ind.mode, source: ind.source, config: ind.config, position: ind.position,
    last_run: ind.last_run, last_error: error, value: period(r), previous: period(previous(r)), series: days(r).map((d) => ({ day: d, value: s[d] ?? null })), goal: null };
}

// ── Lecture : valeur sur la période, période précédente et série pour les courbes ──
export function indicatorView(ind: Row, r: Range): ReturnType<typeof plainView> {
  return ind.source === "formula" ? formulaView(ind, r) : plainView(ind, r);
}
function plainView(ind: Row, r: Range) {
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

export function unknownConfigKeys(source: string, config: unknown): string[] {
  const base = ((configs[source as Source] as any)?._def?.schema ?? configs[source as Source]) as any;
  const shape = typeof base?._def?.shape === "function" ? base._def.shape() : base?.shape;
  const allowed = new Set(Object.keys(shape ?? {}));
  const secretRefs = new Set<string>(SECRET_REFS);
  return Object.keys((config ?? {}) as Row).filter((k) => !allowed.has(k) && !secretRefs.has(k));
}
/** Masque les valeurs des clés hors schéma pour une réponse destinée à une clé. */
export function maskLegacyConfig(source: string, config: unknown): unknown {
  const masked = maskSecrets(config) as Row;
  const secretRefs = new Set<string>(SECRET_REFS);
  for (const k of unknownConfigKeys(source, config)) if (!secretRefs.has(k)) masked[k] = "•••";
  return masked;
}

export function listProjects(r: Range): Row[] {
  return (db.prepare("SELECT * FROM projects ORDER BY position, name").all() as Row[]).map((p) => {
    const proj = decodeProj(p);
    const hidden = hiddenIndicators(p.id); // module retiré du projet : masqué, jamais supprimé
    const indicators = (db.prepare("SELECT * FROM indicators WHERE project_id = ? AND archived_at IS NULL ORDER BY position, created_at").all(p.id) as Row[])
      .filter((i) => !hidden.has(i.id)).map((i) => {
        const view = indicatorView(decodeInd(i), r);
        if (view.last_error) view.last_error = maskUrlSecrets(String(view.last_error));
        if (shouldMaskConfig() && view.config) view.config = maskLegacyConfig(view.source, view.config);
        return view;
      });
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
  db.prepare(`INSERT INTO projects (id, name, color, url, sites, crm_key, position, funnel, pinned, paused, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, color = excluded.color, url = excluded.url, sites = excluded.sites, crm_key = excluded.crm_key, position = excluded.position, funnel = excluded.funnel, pinned = excluded.pinned, paused = excluded.paused`)
    .run(pid, v.name, v.color, v.url, JSON.stringify(v.sites), v.crm_key, v.position, JSON.stringify(v.funnel), v.pinned ? 1 : 0, v.paused ? 1 : 0, cur?.created_at ?? Date.now());
  return decodeProj(db.prepare("SELECT * FROM projects WHERE id = ?").get(pid) as Row);
}
export function saveIndicator(id: string | null, projectId: string | null, input: unknown, admin = true) {
  const cur = id ? getInd(id) : undefined;
  if (id && !cur) return null;
  const v = indicatorFields.parse({ ...cur, ...(input as Row) });
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object"
    ? Object.fromEntries(Object.keys(v as Row).sort().map((k) => [k, canonical((v as Row)[k])])) : v;
  const configChanged = !cur || cur.source !== v.source || JSON.stringify(canonical(cur.config)) !== JSON.stringify(canonical(v.config));
  if (configChanged) v.config = validateIndicatorConfig(v.source, v.config);
  const iid = id ?? randomUUID();
  const actor = admin ? "interface" : "clé";
  if (v.source === "formula") checkTerms(v.config as Formula, cur?.project_id ?? projectId!, iid);
  db.prepare(`INSERT INTO indicators (id, project_id, label, unit, mode, source, config, position, goal, goal_period, stale_after_days, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET label = excluded.label, unit = excluded.unit, mode = excluded.mode, source = excluded.source, config = excluded.config,
    position = excluded.position, goal = excluded.goal, goal_period = excluded.goal_period, stale_after_days = excluded.stale_after_days`)
    .run(iid, cur?.project_id ?? projectId, v.label, v.unit, v.mode, v.source, JSON.stringify(v.config), v.position, v.goal, v.goal ? v.goal_period ?? "month" : null, v.stale_after_days ?? null, cur?.created_at ?? Date.now());
  // Un nouvel indicateur active son module pour le projet : sinon il serait aussitôt masqué
  if (!cur) { const m = indicatorModule({ source: v.source, config: v.config }); if (!getModule(m)?.core) { if (!isEnabled(m)) { if (!admin) throw new Error(`Activez d'abord ${getModule(m)?.name ?? m} dans Modules.`); setEnabled(m, true); } setProjectModule(projectId!, m, true); } }
  // P1-A : changer la source ou la requête n'efface plus l'historique. L'ancienne série part dans un
  // indicateur archivé (copie de l'ancienne définition) ; l'indicateur courant garde son identifiant et repart vide.
  if (cur && (cur.source !== v.source || JSON.stringify(cur.config) !== JSON.stringify(v.config))) archiveIndicator(cur, v, iid);
  // Journal : un champ par ligne, avant/après (config masquée).
  for (const field of ["label", "unit", "mode", "source", "config", "goal", "goal_period"] as const) {
    logIndicatorChange(iid, actor, field, cur?.[field], v[field as keyof typeof v]);
  }
  return getInd(iid)!;
}

/** Copie l'ancienne définition et ses mesures dans un indicateur archivé, et trace l'annotation. */
function archiveIndicator(cur: Row, next: Row, currentId: string) {
  const today = localDay();
  const count = (db.prepare("SELECT COUNT(*) AS n FROM metrics WHERE indicator_id = ?").get(currentId) as { n: number }).n;
  const archiveId = randomUUID();
  if (count > 0) {
    db.prepare(`INSERT INTO indicators (id, project_id, label, unit, mode, source, config, position, last_run, last_error, created_at, archived_at, archived_from)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(archiveId, cur.project_id, `${cur.label} — jusqu'au ${today}`, cur.unit, cur.mode, cur.source, JSON.stringify(cur.config),
        cur.position, cur.last_run, cur.last_error, cur.created_at, Date.now(), currentId);
    db.prepare("UPDATE metrics SET indicator_id = ? WHERE indicator_id = ?").run(archiveId, currentId);
  }
  db.prepare("INSERT INTO annotations (id, project_id, day, label, created_at, milestone, source) VALUES (?, ?, ?, ?, ?, 0, 'indicateur')")
    .run(randomUUID(), cur.project_id, today, `Source changée : ${cur.source} → ${next.source}`, Date.now());
}

/** Séries archivées d'un projet (consultation et export). */
/** Validation unique d'une config : secrets/URL/clés inconnues puis schéma de la source. */
export function validateIndicatorConfig(source: Source, config: unknown): Row {
  // Source inconnue : message clair avant toute lecture de schéma (jamais « Cannot read … »).
  if (!Object.prototype.hasOwnProperty.call(configs, source)) throw new Error(`Source inconnue : ${String(source)}`);
  const secretRefs = new Set<string>(SECRET_REFS);
  if (hasSecretKey(config)) throw new Error(SECRET_CONFIG_ERROR);
  const base = ((configs[source] as any)._def?.schema ?? configs[source]) as any;
  const shape = typeof base?._def?.shape === "function" ? base._def.shape() : base?.shape;
  const allowed = new Set(Object.keys(shape ?? {}));
  const unknown = Object.keys((config ?? {}) as Row).filter((k) => !allowed.has(k) && !secretRefs.has(k));
  if (unknown.length) throw new Error(`Clé non reconnue : ${unknown.join(", ")}. Les secrets se saisissent par variable d'environnement (env)`);
  if (hasUrlSecret(JSON.stringify(config))) throw new Error(SECRET_CONFIG_ERROR);
  const r = configs[source].safeParse(config);
  if (!r.success) throw new Error(`Configuration invalide : ${r.error.issues.map((i) => `${i.path.join(".")} : ${i.message}`).join(", ")}`);
  return r.data as Row;
}

export function archivedIndicators(projectId: string) {
  return db.prepare("SELECT * FROM indicators WHERE project_id = ? AND archived_at IS NOT NULL ORDER BY archived_at DESC").all(projectId)
    .map((r) => ({ ...decodeInd(r as Row), series: db.prepare("SELECT day, value FROM metrics WHERE indicator_id = ? ORDER BY day").all((r as Row).id) }));
}

/** Note ou jalon (date à venir avec compte à rebours) ; source : manuel, agent ou id de module. */
export function saveMilestone(b: { project_id?: string | null; day: string; label: string; milestone?: boolean }, source = "manuel") {
  if (!DAY.test(b.day ?? "") || typeof b.label !== "string" || !b.label.trim()) throw new Error("Date (AAAA-MM-JJ) et texte requis");
  const id = randomUUID();
  db.prepare("INSERT INTO annotations (id, project_id, day, label, milestone, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, b.project_id || null, b.day, b.label.trim().slice(0, 200), b.milestone ? 1 : 0, source, Date.now());
  return { id };
}

/** Jalons des prochains jours (aujourd'hui compris), du plus proche au plus lointain. */
export function upcomingMilestones(projectId?: string, withinDays = 7) {
  const today = localDay();
  const to = day(Date.parse(today) + withinDays * 86400000);
  return (db.prepare(`SELECT id, project_id, day, label FROM annotations WHERE milestone = 1 AND day BETWEEN ? AND ? ${projectId ? "AND (project_id = ? OR project_id IS NULL)" : ""} ORDER BY day`)
    .all(...[today, to, ...(projectId ? [projectId] : [])]) as Row[]).map((m): Row => ({ ...m, daysLeft: Math.round((Date.parse(m.day) - Date.parse(today)) / 86400000) }));
}

export function annotations(projectId: string | undefined, r: Range) {
  const p = projectId ? db.prepare("SELECT id, crm_key FROM projects WHERE id = ?").get(projectId) as Row | undefined : undefined;
  // Un jalon reste un jalon tant que sa date n'est pas passée ; ensuite c'est une note sur la courbe
  const notes = db.prepare(`SELECT id, day, label, CASE WHEN milestone = 1 AND day >= ? THEN 'jalon' ELSE 'note' END AS kind FROM annotations WHERE day BETWEEN ? AND ? ${p ? "AND (project_id = ? OR project_id IS NULL)" : ""}`)
    .all(...[localDay(), r.from, r.to, ...(p ? [p.id] : [])]) as Row[];
  const pubs = db.prepare(`SELECT id, day, title AS label, 'publication' AS kind FROM publications WHERE status = 'published' AND day BETWEEN ? AND ? ${p?.crm_key ? "AND project = ?" : p ? "AND 0" : ""}`)
    .all(...[r.from, r.to, ...(p?.crm_key ? [p.crm_key] : [])]) as Row[];
  return [...notes, ...pubs].sort((a, b) => a.day.localeCompare(b.day));
}

export const rangeOf = (q: Record<string, string>): Range =>
  DAY.test(q.from ?? "") && DAY.test(q.to ?? "") ? { from: q.from, to: q.to } : lastDays(Math.min(Math.max(Number(q.days) || 28, 1), 500));

export function registerProjects(app: Hono) {
  const bad = (e: unknown) => e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")} : ${i.message}`).join(", ") : (e as Error).message;

  app.get("/api/projects", (c) => {
    const agent = (c as any).get("agent");
    const list = listProjects(rangeOf(c.req.query()));
    const ids = agent ? visibleProjectIds(agent) : null;
    return c.json(ids ? list.filter((p) => ids.has(p.id)) : list);
  });
  app.get("/api/projects/:id", (c) => { const p = getProject(c.req.param("id"), rangeOf(c.req.query())); return p ? c.json(p) : c.json({ error: "Projet introuvable" }, 404); });
  app.post("/api/projects", async (c) => { try { return c.json(saveProject(null, await c.req.json()), 201); } catch (e) { return c.json({ error: bad(e) }, 400); } });
  app.patch("/api/projects/:id", async (c) => {
    try { const p = saveProject(c.req.param("id"), await c.req.json()); return p ? c.json(p) : c.json({ error: "Projet introuvable" }, 404); } catch (e) { return c.json({ error: bad(e) }, 400); }
  });
  app.delete("/api/projects/:id", (c) => {
    const agent = (c as any).get("agent") as { id: string } | undefined;
    if (agent) {
      // J2 : suppression d'un projet par une clé = approbation admin, usage unique, portée revérifiée.
      const approvalId = c.req.header("x-approval-id");
      if (!approvalId) return c.json({ error: "Approbation requise" }, 403);
      const id = c.req.param("id");
      if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(id)) return c.json({ error: "Introuvable" }, 404);
      if (!canAccess(agent as any, id, "write")) return c.json({ error: "Introuvable" }, 404);
      // Suppression en cascade définitive : instantané de la base d'abord ; sans lui, rien n'est supprimé.
      try { snapshotBeforeDelete(`projet-${id}`); } catch (e) { return c.json({ error: `Instantané avant suppression impossible : ${(e as Error).message}` }, 500); }
      db.exec("BEGIN");
      try {
        const consumed = consumeApproval(approvalId, { agentId: agent.id, action: "project_delete", projectId: id, targetId: id, payload: {} });
        if (consumed !== "ok") { db.exec("ROLLBACK"); securityEvent("approval_refused", consumed); return c.json({ error: "Approbation refusée ou déjà utilisée" }, 409); }
        const r = db.prepare("DELETE FROM projects WHERE id = ?").run(id);
        if (!r.changes) { db.exec("ROLLBACK"); return c.json({ error: "Introuvable" }, 404); }
        db.exec("COMMIT");
        return c.json({ ok: true });
      } catch (e) { db.exec("ROLLBACK"); return c.json({ error: (e as Error).message }, 400); }
    }
    if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(c.req.param("id"))) return c.json({ error: "Projet introuvable" }, 404);
    try { snapshotBeforeDelete(`projet-${c.req.param("id")}`); } catch (e) { return c.json({ error: `Instantané avant suppression impossible : ${(e as Error).message}` }, 500); }
    return db.prepare("DELETE FROM projects WHERE id = ?").run(c.req.param("id")).changes ? c.json({ ok: true }) : c.json({ error: "Projet introuvable" }, 404);
  });

  app.post("/api/projects/:id/indicators", async (c) => {
    if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(c.req.param("id"))) return c.json({ error: "Projet introuvable" }, 404);
    try {
      const ind = saveIndicator(null, c.req.param("id"), await c.req.json(), isAdmin(c))!;
      await collect(ind, 90).catch(() => {}); // l'erreur éventuelle reste visible sur l'indicateur
      return c.json(getInd(ind.id), 201);
    } catch (e) { return c.json({ error: bad(e) }, 400); }
  });
  app.patch("/api/indicators/:id", async (c) => {
    const agent = (c as any).get("agent") as { id: string } | undefined;
    if (!agent && !isAdmin(c)) return c.json({ error: "Réservé à l'administrateur ou à une approbation de clé d'agent" }, 403);
    if (agent) {
      const approvalId = c.req.header("x-approval-id");
      if (!approvalId) return c.json({ error: "Approbation requise" }, 403);
      const cur = getInd(c.req.param("id"));
      if (!cur) return c.json({ error: "Introuvable" }, 404);
      const body = await c.req.json().catch(() => ({}));
      db.exec("BEGIN");
      try {
        if (!canAccess(agent as any, String(cur.project_id), "write")) { db.exec("ROLLBACK"); return c.json({ error: "Introuvable" }, 404); }
        const ind = saveIndicator(cur.id, null, body, false);
        if (!ind) { db.exec("ROLLBACK"); return c.json({ error: "Introuvable" }, 404); }
        const consumed = consumeApproval(approvalId, { agentId: agent.id, action: "indicator_source", projectId: String(cur.project_id), targetId: cur.id, payload: body });
        if (consumed !== "ok") { db.exec("ROLLBACK"); securityEvent("approval_refused", consumed); return c.json({ error: "Approbation refusée ou déjà utilisée" }, 409); }
        db.exec("COMMIT");
        await collect(ind, 90).catch(() => {});
        return c.json(getInd(ind.id));
      } catch (e) { db.exec("ROLLBACK"); return c.json({ error: bad(e) }, 400); }
    }
    try {
      const ind = saveIndicator(c.req.param("id"), null, await c.req.json(), isAdmin(c));
      if (!ind) return c.json({ error: "Indicateur introuvable" }, 404);
      await collect(ind, 90).catch(() => {});
      return c.json(getInd(ind.id));
    } catch (e) { return c.json({ error: bad(e) }, 400); }
  });
  app.delete("/api/indicators/:id", async (c) => {
    const agent = (c as any).get("agent") as { id: string } | undefined;
    if (agent) {
      // L1 : suppression d'un indicateur par une clé = action gardée par approbation admin, usage unique.
      const approvalId = c.req.header("x-approval-id");
      if (!approvalId) return c.json({ error: "Approbation requise" }, 403);
      const ind = getInd(c.req.param("id"));
      if (!ind) return c.json({ error: "Introuvable" }, 404);
      if (!canAccess(agent as any, String(ind.project_id), "write")) return c.json({ error: "Introuvable" }, 404);
      db.exec("BEGIN");
      try {
        const consumed = consumeApproval(approvalId, { agentId: agent.id, action: "indicator_delete", projectId: String(ind.project_id), targetId: ind.id, payload: {} });
        if (consumed !== "ok") { db.exec("ROLLBACK"); securityEvent("approval_refused", consumed); return c.json({ error: "Approbation refusée ou déjà utilisée" }, 409); }
        const r = db.prepare("DELETE FROM indicators WHERE id = ?").run(ind.id);
        if (!r.changes) { db.exec("ROLLBACK"); return c.json({ error: "Introuvable" }, 404); }
        db.exec("COMMIT");
        return c.json({ ok: true });
      } catch (e) { db.exec("ROLLBACK"); return c.json({ error: (e as Error).message }, 400); }
    }
    return db.prepare("DELETE FROM indicators WHERE id = ?").run(c.req.param("id")).changes ? c.json({ ok: true }) : c.json({ error: "Indicateur introuvable" }, 404);
  });

  // P1-A : archives consultables, restauration et suppression définitive (administrateur, nom saisi).
  app.get("/api/indicators/:id/changes", (c) => {
    if (!isAdmin(c)) return c.json({ error: "Réservé à l'administrateur" }, 403);
    return c.json(db.prepare("SELECT ts, actor, field, before, after FROM indicator_changes WHERE indicator_id = ? ORDER BY id DESC LIMIT 200").all(c.req.param("id")));
  });
  app.get("/api/projects/:id/archives", (c) => {
    if (!isAdmin(c)) return c.json({ error: "Réservé à l'administrateur" }, 403);
    if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(c.req.param("id"))) return c.json({ error: "Projet introuvable" }, 404);
    return c.json(archivedIndicators(c.req.param("id")));
  });
  app.post("/api/indicators/:id/restore", (c) => {
    if (!isAdmin(c)) return c.json({ error: "Réservé à l'administrateur" }, 403);
    const arch = db.prepare("SELECT * FROM indicators WHERE id = ? AND archived_at IS NOT NULL").get(c.req.param("id")) as Row | undefined;
    if (!arch?.archived_from) return c.json({ error: "Archive introuvable" }, 404);
    const current = getInd(String(arch.archived_from));
    if (!current) return c.json({ error: "Indicateur courant introuvable" }, 404);
    const today = localDay();
    const tmp = `tmp:${randomUUID()}`;
    const oldLabel = String(current.label);
    const archLabel = String(arch.label).replace(/ — jusqu'au .*$/, "");
    const fields = (r: Row) => [r.unit ?? null, r.mode, r.source, JSON.stringify(r.config ?? {}), r.position ?? 0, r.goal ?? null, r.goal_period ?? null, r.stale_after_days ?? null, r.last_run ?? null, r.last_error ?? null];
    db.exec("PRAGMA defer_foreign_keys = ON");
    db.exec("BEGIN");
    try {
      // Échange transactionnel des séries (via un identifiant temporaire pour éviter les collisions de jours).
      db.prepare("UPDATE metrics SET indicator_id = ? WHERE indicator_id = ?").run(tmp, current.id);
      db.prepare("UPDATE metrics SET indicator_id = ? WHERE indicator_id = ?").run(current.id, String(arch.id));
      db.prepare("UPDATE metrics SET indicator_id = ? WHERE indicator_id = ?").run(String(arch.id), tmp);
      // Échange des définitions : l'ancienne revient sur le courant, la nouvelle part dans l'archive.
      const [au, am, as, ac, ap, ag, agp, ast, alr, ale] = fields(arch);
      const [cu, cm, cs, cc, cp, cg, cgp, cst, clr, cle] = fields(current);
      db.prepare(`UPDATE indicators SET label = ?, unit = ?, mode = ?, source = ?, config = ?, position = ?, goal = ?, goal_period = ?, stale_after_days = ?, last_run = ?, last_error = ? WHERE id = ?`)
        .run(archLabel, au, am, as, ac, ap, ag, agp, ast, alr, ale, current.id);
      db.prepare(`UPDATE indicators SET label = ?, unit = ?, mode = ?, source = ?, config = ?, position = ?, goal = ?, goal_period = ?, stale_after_days = ?, last_run = ?, last_error = ?, archived_at = ?, archived_from = ? WHERE id = ?`)
        .run(`${oldLabel} — jusqu'au ${today}`, cu, cm, cs, cc, cp, cg, cgp, cst, clr, cle, Date.now(), current.id, String(arch.id));
      db.prepare("INSERT INTO annotations (id, project_id, day, label, created_at, milestone, source) VALUES (?, ?, ?, ?, ?, 0, 'indicateur')")
        .run(randomUUID(), arch.project_id, today, `Segment restauré : ${archLabel}`, Date.now());
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    return c.json(getInd(current.id));
  });
  app.delete("/api/indicators/:id/permanent", async (c) => {
    if (!isAdmin(c)) return c.json({ error: "Réservé à l'administrateur" }, 403);
    const ind = getInd(c.req.param("id"));
    if (!ind) return c.json({ error: "Indicateur introuvable" }, 404);
    const b = await c.req.json().catch(() => ({}));
    if (b.confirm !== ind.label) return c.json({ error: "Saisissez le nom exact de l'indicateur pour confirmer" }, 400);
    db.prepare("DELETE FROM indicators WHERE id = ?").run(ind.id);
    return c.json({ ok: true });
  });
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
    if (ind.archived_at) return c.json({ error: "Série archivée : non relevée" }, 409);
    try { return c.json(await collect(ind, Number(c.req.query("days")) || 1)); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });
  // SEC-07 : le jour fourni doit être réel et borné ; une valeur finie et |v| ≤ 1e12.
  const validDay = (s: unknown): s is string => {
    if (typeof s !== "string" || !DAY.test(s)) return false;
    const d = new Date(`${s}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return false;
    return s >= "2000-01-01" && s <= new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  };
  const validValue = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1e12;
  app.post("/api/indicators/:id/value", async (c) => {
    const ind = getInd(c.req.param("id"));
    if (!ind) return c.json({ error: "Indicateur introuvable" }, 404);
    const b = await c.req.json().catch(() => ({}));
    if (b.day !== undefined && !validDay(b.day)) return c.json({ error: "Jour invalide (AAAA-MM-JJ réel, entre 2000-01-01 et demain)" }, 400);
    if (!validValue(b.value)) return c.json({ error: "Valeur invalide (nombre fini, |v| ≤ 10^12)" }, 400);
    const d = b.day ?? localDay();
    record(ind.id, d, b.value);
    return c.json({ ok: true, day: d });
  });
  // Import de lot : 366 valeurs au plus, tout ou rien.
  app.post("/api/indicators/:id/values", async (c) => {
    const ind = getInd(c.req.param("id"));
    if (!ind) return c.json({ error: "Indicateur introuvable" }, 404);
    const b = await c.req.json().catch(() => ({}));
    const rows = Array.isArray(b.values) ? b.values : null;
    if (!rows || !rows.length || rows.length > 366) return c.json({ error: "366 valeurs maximum" }, 400);
    for (const r of rows) {
      if (!validDay(r?.day) || !validValue(r?.value)) return c.json({ error: "Jour ou valeur invalide dans le lot" }, 400);
    }
    db.exec("BEGIN");
    try { for (const r of rows) record(ind.id, r.day, r.value); db.exec("COMMIT"); }
    catch (e) { db.exec("ROLLBACK"); throw e; }
    return c.json({ ok: true, count: rows.length });
  });

  // Repères des courbes : notes datées et publications du projet
  app.get("/api/milestones", (c) => c.json(upcomingMilestones(c.req.query("project") || undefined, Math.min(Number(c.req.query("days")) || 30, 365))));
  app.get("/api/annotations", (c) => c.json(annotations(c.req.query("project"), rangeOf(c.req.query()))));
  app.post("/api/annotations", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    try { return c.json(saveMilestone({ project_id: b.project_id, day: b.day, label: b.label, milestone: !!b.milestone }), 201); }
    catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });
  app.delete("/api/annotations/:id", (c) => db.prepare("DELETE FROM annotations WHERE id = ?").run(c.req.param("id")).changes ? c.json({ ok: true }) : c.json({ error: "Repère introuvable" }, 404));

  // Relevé au démarrage (premier tic de l'ordonnanceur) puis toutes les 3 h
  registerJob("projets", { id: "indicators", every: "3h", run: async () => { await collectAll(); } });
}

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
export function registerProjectTools(server: McpServer, readOnly = false) {
  server.registerTool("projects_kpis", {
    description: "Tous les projets avec leurs indicateurs clés (valeur sur la période, période précédente) : inscriptions, ventes, revenus, visiteurs…",
    inputSchema: z.object({ days: z.number().int().min(1).max(500).default(28) }),
  }, async ({ days }) => json(listProjects(lastDays(days)).map((p) => ({ id: p.id, name: p.name, crm_key: p.crm_key, sites: p.sites,
    indicators: p.indicators.map((i: Record<string, any>) => ({ id: i.id, label: i.label, unit: i.unit, mode: i.mode, value: i.value, previous: i.previous, error: i.last_error })) }))));
  server.registerTool("milestones_list", {
    description: "Jalons à venir (lancements, échéances) avec le nombre de jours restants ; tous projets ou un seul.",
    inputSchema: z.object({ project: z.string().optional().describe("id du projet (facultatif)"), days: z.number().int().min(1).max(365).default(30) }),
  }, async ({ project, days }) => json(upcomingMilestones(project, days)));
  if (!readOnly) server.registerTool("milestone_save", {
    description: "Ajoute un jalon (date à venir, compte à rebours dans « Aujourd'hui » à J-7) ou une note sur les courbes (milestone: false).",
    inputSchema: z.object({ project: z.string().optional().describe("id du projet ; absent = tous les projets"), day: z.string().describe("AAAA-MM-JJ"), label: z.string(), milestone: z.boolean().default(true) }),
  }, async ({ project, day: d, label, milestone }) => json(saveMilestone({ project_id: project ?? null, day: d, label, milestone }, "agent")));
  if (!readOnly) server.registerTool("indicator_record", {
    description: "Enregistre à la main la valeur d'un indicateur pour un jour (ex. abonnés TikTok). Donne l'id obtenu avec projects_kpis.",
    inputSchema: z.object({ id: z.string(), value: z.number(), day: z.string().regex(DAY).optional() }),
  }, async ({ id, value, day: d }) => { if (!getInd(id)) return json({ error: "Indicateur introuvable" }); record(id, d ?? localDay(), value); return json({ ok: true }); });
}
