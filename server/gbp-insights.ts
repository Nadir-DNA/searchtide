// Fiches Google Business Profile (plan A8) : avis et note, appels, itinéraires, clics vers le site et vues de la fiche,
// pour chaque fiche connectée en compte de publication (réseau « gbp »). Répondre à un avis depuis Searchtide, avec un
// brouillon proposé par l'IA si elle est connectée. Les avis sans réponse remontent dans « À traiter ».
import type { Hono } from "hono";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { db } from "./db.ts";
import { migrate } from "./migrations.ts";
import { registerJob } from "./jobs.ts";
import { isAdmin } from "./admin.ts";
import { credentialsFor } from "./publishers/tokens.ts";
import { addTodaySource, itemKey, type TodayItem } from "./today.ts";
import { aiConnection, complete } from "./assistant.ts";
import "./publishers/queue.ts";

type Row = Record<string, any>;
type Creds = (account: Row) => Promise<{ ok: true; token: string; accountId: string } | { ok: false; message: string }>;

migrate("2026-11-17-fiches-google", `
CREATE TABLE gbp_daily (account_id TEXT NOT NULL, day TEXT NOT NULL, views INTEGER, calls INTEGER, directions INTEGER, website INTEGER, PRIMARY KEY (account_id, day));
CREATE TABLE gbp_profile (account_id TEXT PRIMARY KEY, rating REAL, total INTEGER, checked_at INTEGER, error TEXT);
CREATE TABLE gbp_reviews (account_id TEXT NOT NULL, review_id TEXT NOT NULL, author TEXT, rating INTEGER, comment TEXT, created_at TEXT, reply TEXT, replied_at TEXT,
  PRIMARY KEY (account_id, review_id));`);

const STARS: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
const METRICS: Record<string, "views" | "calls" | "directions" | "website"> = {
  BUSINESS_IMPRESSIONS_DESKTOP_MAPS: "views", BUSINESS_IMPRESSIONS_DESKTOP_SEARCH: "views", BUSINESS_IMPRESSIONS_MOBILE_MAPS: "views", BUSINESS_IMPRESSIONS_MOBILE_SEARCH: "views",
  CALL_CLICKS: "calls", BUSINESS_DIRECTION_REQUESTS: "directions", WEBSITE_CLICKS: "website",
};
const ymd = (d: Date, k: string) => ({ [`dailyRange.${k}_date.year`]: String(d.getUTCFullYear()), [`dailyRange.${k}_date.month`]: String(d.getUTCMonth() + 1), [`dailyRange.${k}_date.day`]: String(d.getUTCDate()) });
const pad = (n: number) => String(n).padStart(2, "0");

/** Relève une fiche : avis (50 derniers), note, et actions jour par jour sur 30 jours. `f` et `creds` remplaçables dans les tests. */
export async function collectLocation(account: Row, o: { creds?: Creds; fetch?: typeof fetch; now?: Date } = {}) {
  const f = o.fetch ?? fetch, now = o.now ?? new Date();
  const c = await (o.creds ?? credentialsFor)(account);
  const fail = (m: string) => { db.prepare("INSERT INTO gbp_profile (account_id, checked_at, error) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET checked_at = excluded.checked_at, error = excluded.error").run(account.id, now.getTime(), m.slice(0, 300)); return { error: m }; };
  if (!c.ok) return fail(c.message);
  const h = { Authorization: `Bearer ${c.token}` };
  const r = await f(`https://mybusiness.googleapis.com/v4/${c.accountId}/reviews?pageSize=50`, { headers: h, signal: AbortSignal.timeout(30_000) });
  const j = await r.json().catch(() => ({})) as Row;
  if (!r.ok) return fail(r.status === 403 ? "Accès aux avis refusé par Google (API Business Profile à demander)" : `Avis illisibles (${r.status})`);
  const up = db.prepare(`INSERT INTO gbp_reviews (account_id, review_id, author, rating, comment, created_at, reply, replied_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, review_id) DO UPDATE SET rating = excluded.rating, comment = excluded.comment, reply = excluded.reply, replied_at = excluded.replied_at`);
  for (const v of j.reviews ?? []) up.run(account.id, String(v.reviewId), v.reviewer?.isAnonymous ? "Anonyme" : String(v.reviewer?.displayName ?? "Anonyme"), STARS[v.starRating] ?? null,
    v.comment ? String(v.comment).slice(0, 4000) : null, v.createTime ?? null, v.reviewReply?.comment ?? null, v.reviewReply?.updateTime ?? null);
  db.prepare(`INSERT INTO gbp_profile (account_id, rating, total, checked_at, error) VALUES (?, ?, ?, ?, NULL)
    ON CONFLICT(account_id) DO UPDATE SET rating = excluded.rating, total = excluded.total, checked_at = excluded.checked_at, error = NULL`)
    .run(account.id, j.averageRating ?? null, j.totalReviewCount ?? null, now.getTime());
  // Actions de la fiche : Google publie avec environ deux jours de retard.
  const location = String(c.accountId).slice(String(c.accountId).indexOf("locations/"));
  const end = new Date(now.getTime() - 2 * 86_400_000), start = new Date(end.getTime() - 29 * 86_400_000);
  const q = new URLSearchParams({ ...ymd(start, "start"), ...ymd(end, "end") });
  for (const m of Object.keys(METRICS)) q.append("dailyMetrics", m);
  const pr = await f(`https://businessprofileperformance.googleapis.com/v1/${location}:fetchMultiDailyMetricsTimeSeries?${q}`, { headers: h, signal: AbortSignal.timeout(30_000) });
  if (pr.ok) {
    const days = new Map<string, Record<string, number>>();
    for (const s of ((await pr.json()) as Row).multiDailyMetricTimeSeries ?? []) for (const d of s.dailyMetricTimeSeries ?? []) {
      const col = METRICS[d.dailyMetric]; if (!col) continue;
      for (const v of d.timeSeries?.datedValues ?? []) {
        const day = `${v.date.year}-${pad(v.date.month)}-${pad(v.date.day)}`;
        const row = days.get(day) ?? {}; row[col] = (row[col] ?? 0) + (Number(v.value) || 0); days.set(day, row);
      }
    }
    const ins = db.prepare(`INSERT INTO gbp_daily (account_id, day, views, calls, directions, website) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, day) DO UPDATE SET views = excluded.views, calls = excluded.calls, directions = excluded.directions, website = excluded.website`);
    for (const [day, v] of days) ins.run(account.id, day, v.views ?? 0, v.calls ?? 0, v.directions ?? 0, v.website ?? 0);
  }
  return { reviews: (j.reviews ?? []).length, rating: j.averageRating ?? null };
}

export async function collectAllLocations() {
  for (const a of db.prepare("SELECT * FROM pub_accounts WHERE network = 'gbp' AND connection_id IS NOT NULL AND status = 'connected'").all() as Row[])
    await collectLocation(a).catch((e) => console.error(`[fiches Google] ${a.label} :`, (e as Error).message));
}

/** Synthèse par fiche : note, nombre d'avis, actions sur `days` jours comparées à la période d'avant, avis récents. */
export function locationsReport(o: { project?: string; days?: number } = {}) {
  const days = Math.min(Math.max(o.days ?? 28, 7), 90);
  const p = o.project ? db.prepare("SELECT id, crm_key FROM projects WHERE id = ? OR crm_key = ?").get(o.project, o.project) as Row | undefined : undefined;
  const accounts = db.prepare(`SELECT * FROM pub_accounts WHERE network = 'gbp' ${p ? "AND project IN (?, ?)" : ""} ORDER BY label`).all(...(p ? [p.id, p.crm_key ?? p.id] : [])) as Row[];
  const today = new Date().toISOString().slice(0, 10);
  const back = (n: number) => new Date(Date.parse(today) - n * 86_400_000).toISOString().slice(0, 10);
  const sum = (id: string, from: string, to: string) => db.prepare("SELECT COUNT(*) AS n, SUM(views) AS views, SUM(calls) AS calls, SUM(directions) AS directions, SUM(website) AS website FROM gbp_daily WHERE account_id = ? AND day > ? AND day <= ?").get(id, from, to) as Row;
  return accounts.map((a) => {
    const prof = db.prepare("SELECT * FROM gbp_profile WHERE account_id = ?").get(a.id) as Row | undefined;
    const now = sum(a.id, back(days), today), before = sum(a.id, back(days * 2), back(days));
    const pick = (r: Row) => r.n ? { views: r.views, calls: r.calls, directions: r.directions, website: r.website } : null;
    return {
      id: a.id, label: a.label, project: a.project, connected: !!a.connection_id, rating: prof?.rating ?? null, total: prof?.total ?? null, error: prof?.error ?? null, checkedAt: prof?.checked_at ?? null,
      actions: pick(now), previous: pick(before),
      unanswered: (db.prepare("SELECT COUNT(*) AS n FROM gbp_reviews WHERE account_id = ? AND reply IS NULL").get(a.id) as Row).n as number,
      reviews: db.prepare("SELECT review_id, author, rating, comment, created_at, reply FROM gbp_reviews WHERE account_id = ? ORDER BY created_at DESC LIMIT 20").all(a.id) as Row[],
    };
  });
}

/** Répond à un avis (ou modifie la réponse). Le texte part tel quel sur Google. */
export async function replyReview(accountId: string, reviewId: string, text: string, o: { creds?: Creds; fetch?: typeof fetch } = {}) {
  const t = String(text ?? "").trim();
  if (t.length < 2 || t.length > 4000) throw new Error("Réponse de 2 à 4 000 caractères");
  const a = db.prepare("SELECT * FROM pub_accounts WHERE id = ? AND network = 'gbp'").get(accountId) as Row | undefined;
  if (!a) throw new Error("Fiche introuvable");
  if (!db.prepare("SELECT 1 FROM gbp_reviews WHERE account_id = ? AND review_id = ?").get(accountId, reviewId)) throw new Error("Avis introuvable");
  const c = await (o.creds ?? credentialsFor)(a);
  if (!c.ok) throw new Error(c.message);
  const r = await (o.fetch ?? fetch)(`https://mybusiness.googleapis.com/v4/${c.accountId}/reviews/${encodeURIComponent(reviewId)}/reply`, {
    method: "PUT", headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ comment: t }), signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(r.status === 403 ? "Google refuse la réponse : vérifiez l'accès à la fiche" : `Google répond ${r.status}`);
  db.prepare("UPDATE gbp_reviews SET reply = ?, replied_at = ? WHERE account_id = ? AND review_id = ?").run(t, new Date().toISOString(), accountId, reviewId);
  return { ok: true };
}

/** Brouillon de réponse par l'IA connectée : courtois, personnalisé, sans promesse ni chiffre inventé. */
export async function draftReply(accountId: string, reviewId: string, o: { fetch?: typeof fetch } = {}) {
  const v = db.prepare("SELECT r.*, a.label FROM gbp_reviews r JOIN pub_accounts a ON a.id = r.account_id WHERE r.account_id = ? AND r.review_id = ?").get(accountId, reviewId) as Row | undefined;
  if (!v) throw new Error("Avis introuvable");
  const conn = aiConnection();
  if (!conn) throw new Error("Aucune IA connectée : écrivez la réponse vous-même, ou ajoutez une clé dans Connexions");
  const prompt = `Établissement : ${v.label}\nAvis de ${v.author} (${v.rating ?? "?"}/5) :\n« ${v.comment ?? "(sans texte)"} »\n\nÉcris la réponse publique de l'établissement, en français, 2 à 4 phrases : remercie, réponds au point soulevé, ${Number(v.rating) <= 3 ? "reconnais le problème sans te justifier longuement et invite à poursuivre en privé, " : ""}sans promesse précise ni information inventée. Réponds uniquement par le texte.`;
  return { text: await complete(conn, "Tu rédiges les réponses aux avis Google d'un commerce ou d'une entreprise, avec chaleur et sobriété.", prompt, { fetch: o.fetch, maxTokens: 800 }) };
}

/** « À traiter » : avis sans réponse des 30 derniers jours, en priorité les notes de 1 à 3. */
function reviewItems(): TodayItem[] {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const rows = db.prepare(`SELECT a.id, a.label, pr.id AS project_id, COUNT(*) AS n, MIN(r.rating) AS worst FROM gbp_reviews r JOIN pub_accounts a ON a.id = r.account_id
    LEFT JOIN projects pr ON pr.id = a.project OR pr.crm_key = a.project WHERE r.reply IS NULL AND r.created_at >= ? GROUP BY a.id`).all(since) as Row[];
  return rows.map((r) => ({ key: itemKey("avis", r.id, String(r.n)), kind: "action", tone: Number(r.worst) <= 3 ? "warn" : "info", project_id: r.project_id ?? null,
    text: `${r.label} · ${r.n} avis Google sans réponse${Number(r.worst) <= 3 ? ` (dont une note de ${r.worst}/5)` : ""}`, to: { view: "pubs" } }));
}
addTodaySource(reviewItems);

export function registerGbpInsights(app: Hono) {
  registerJob("publications", { id: "fiches-google", every: "24h", run: () => collectAllLocations() });
  const admin = (c: any) => isAdmin(c) ? null : c.json({ error: "Réservé à l'administrateur" }, 403);
  const wrap = (fn: (c: any) => Promise<Response> | Response) => async (c: any) => { const d = admin(c); if (d) return d; try { return await fn(c); } catch (e) { return c.json({ error: (e as Error).message }, 400); } };
  app.get("/api/gbp", wrap((c) => c.json(locationsReport({ project: c.req.query("project") || undefined, days: Number(c.req.query("days")) || 28 }))));
  app.post("/api/gbp/refresh", wrap(async (c) => { await collectAllLocations(); return c.json(locationsReport({ project: c.req.query("project") || undefined })); }));
  app.post("/api/gbp/:account/reviews/:review/reply", wrap(async (c) => c.json(await replyReview(c.req.param("account"), c.req.param("review"), (await c.req.json().catch(() => ({}))).text))));
  app.post("/api/gbp/:account/reviews/:review/draft", wrap(async (c) => c.json(await draftReply(c.req.param("account"), c.req.param("review")))));
}

export function registerGbpTools(server: McpServer) {
  server.registerTool("gbp_overview", {
    description: "Fiches Google Business Profile d'un projet : note, nombre d'avis, avis récents et réponses, vues de la fiche, appels, itinéraires et clics vers le site sur la période, comparés à la période précédente.",
    inputSchema: z.object({ project: z.string().describe("id ou clé du projet"), days: z.number().int().min(7).max(90).default(28) }),
  }, async ({ project, days }) => ({ content: [{ type: "text" as const, text: JSON.stringify(locationsReport({ project, days }), null, 2) }] }));
}
