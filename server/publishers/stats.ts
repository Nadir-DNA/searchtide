// Statistiques des réseaux (plan D3) : abonnés par compte (un relevé par jour) et chiffres des publications
// des 30 derniers jours, lus par les fournisseurs avec les autorisations déjà accordées. Un réseau qui ne fournit
// rien est dit tel quel ; un chiffre absent reste absent (jamais 0 par défaut).
import type { Hono } from "hono";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { db, localDay } from "../db.ts";
import { migrate } from "../migrations.ts";
import { registerJob } from "../jobs.ts";
import { isAdmin } from "../admin.ts";
import { providerFor } from "./provider.ts";
import { credentialsFor } from "./tokens.ts";

type Row = Record<string, any>;
type Creds = (account: Row) => Promise<{ ok: true; token: string; accountId: string } | { ok: false; message: string }>;

migrate("2026-11-15-statistiques-reseaux", `
CREATE TABLE social_stats (account_id TEXT NOT NULL, day TEXT NOT NULL, followers INTEGER, posts INTEGER, views INTEGER, PRIMARY KEY (account_id, day));
CREATE TABLE post_stats (publication_id TEXT PRIMARY KEY, impressions INTEGER, likes INTEGER, comments INTEGER, shares INTEGER, views INTEGER, updated_at INTEGER NOT NULL);`);

/** Colonnes d'état sur les comptes : la table vient du module Publications, peut-être pas encore créée au chargement. */
function ensureColumns() {
  for (const sql of ["ALTER TABLE pub_accounts ADD COLUMN stats_error TEXT", "ALTER TABLE pub_accounts ADD COLUMN stats_at INTEGER"]) {
    try { db.exec(sql); } catch { /* déjà présente, ou table pas encore créée */ }
  }
}
ensureColumns();

/** Relève les statistiques d'un compte relié à un vrai réseau. `creds` est remplaçable dans les tests. */
export async function collectAccount(account: Row, creds: Creds = credentialsFor, now = new Date()) {
  const provider = providerFor(String(account.network));
  if (!account.connection_id || !provider?.stats) return { skipped: true };
  ensureColumns();
  const c = await creds(account);
  const fail = (message: string) => { db.prepare("UPDATE pub_accounts SET stats_error = ?, stats_at = ? WHERE id = ?").run(message.slice(0, 300), now.getTime(), account.id); return { error: message }; };
  if (!c.ok) return fail(c.message);
  try {
    const s = await provider.stats(c.token, c.accountId);
    db.prepare(`INSERT INTO social_stats (account_id, day, followers, posts, views) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(account_id, day) DO UPDATE SET followers = excluded.followers, posts = excluded.posts, views = excluded.views`)
      .run(account.id, localDay(now), s.followers ?? null, s.posts ?? null, s.views ?? null);
    let posts = 0;
    if (provider.postStats) {
      const since = now.getTime() - 30 * 86_400_000;
      const pubs = db.prepare(`SELECT id, evidence_url FROM publications WHERE account_id = ? AND state = 'published' AND evidence_url IS NOT NULL
        AND COALESCE(published_at, updated_at) >= ?`).all(account.id, since) as Row[];
      if (pubs.length) {
        const byUrl = await provider.postStats(pubs.map((p) => String(p.evidence_url)), c.token, c.accountId);
        for (const p of pubs) {
          const m = byUrl[String(p.evidence_url)];
          if (!m) continue;
          db.prepare(`INSERT INTO post_stats (publication_id, impressions, likes, comments, shares, views, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(publication_id) DO UPDATE SET impressions = excluded.impressions, likes = excluded.likes, comments = excluded.comments,
            shares = excluded.shares, views = excluded.views, updated_at = excluded.updated_at`)
            .run(p.id, m.impressions ?? null, m.likes ?? null, m.comments ?? null, m.shares ?? null, m.views ?? null, now.getTime());
          posts++;
        }
      }
    }
    db.prepare("UPDATE pub_accounts SET stats_error = NULL, stats_at = ? WHERE id = ?").run(now.getTime(), account.id);
    return { followers: s.followers ?? null, posts };
  } catch (e) { return fail((e as Error).message); }
}

export async function collectAll(creds: Creds = credentialsFor) {
  const accounts = db.prepare("SELECT * FROM pub_accounts WHERE connection_id IS NOT NULL AND status = 'connected'").all() as Row[];
  for (const a of accounts) await collectAccount(a, creds).catch((e) => console.error(`[statistiques] ${a.label} :`, (e as Error).message));
}

/** Dernier relevé d'abonnés à une date donnée ou avant. */
const followersAt = (accountId: string, day: string) =>
  (db.prepare("SELECT followers FROM social_stats WHERE account_id = ? AND day <= ? AND followers IS NOT NULL ORDER BY day DESC LIMIT 1").get(accountId, day) as Row | undefined)?.followers as number | undefined;

const projectKeys = (project?: string) => {
  if (!project) return null;
  const p = db.prepare("SELECT id, crm_key FROM projects WHERE id = ? OR crm_key = ?").get(project, project) as Row | undefined;
  return p ? [p.id, p.crm_key ?? p.id] : [project, project];
};

/** Vue d'ensemble : un compte par ligne (abonnés, évolution sur `days`, courbe), puis les meilleures publications. */
export function socialStats(o: { project?: string; days?: number } = {}, today = localDay()) {
  const days = Math.min(Math.max(o.days ?? 28, 1), 365);
  const since = new Date(Date.parse(today) - days * 86_400_000).toISOString().slice(0, 10);
  const keys = projectKeys(o.project);
  const accounts = db.prepare(`SELECT * FROM pub_accounts ${keys ? "WHERE project IN (?, ?)" : ""} ORDER BY project, network, label`).all(...(keys ?? [])) as Row[];
  const rows = accounts.map((a) => {
    const provider = providerFor(String(a.network));
    const last = db.prepare("SELECT * FROM social_stats WHERE account_id = ? ORDER BY day DESC LIMIT 1").get(a.id) as Row | undefined;
    return {
      id: a.id, label: a.label, network: a.network, project: a.project,
      real: !!a.connection_id, supported: !!a.connection_id && !!provider?.stats,
      unavailable: !a.connection_id ? "Compte sans connexion réelle : rien à relever" : provider?.stats ? null : provider?.statsUnavailable ?? "Ce réseau ne fournit pas de statistiques",
      followers: last?.followers ?? null, followersBefore: followersAt(a.id, since) ?? null, posts: last?.posts ?? null, views: last?.views ?? null,
      day: last?.day ?? null, error: a.stats_error ?? null, checkedAt: a.stats_at ?? null,
      series: (db.prepare("SELECT day, followers FROM social_stats WHERE account_id = ? AND day >= ? AND followers IS NOT NULL ORDER BY day").all(a.id, since) as Row[]),
    };
  });
  const ids = accounts.map((a) => a.id);
  const top = ids.length ? db.prepare(`SELECT p.id, p.title, p.network, p.evidence_url AS url, p.day, s.impressions, s.likes, s.comments, s.shares, s.views,
      COALESCE(s.likes, 0) + COALESCE(s.comments, 0) + COALESCE(s.shares, 0) AS engagement
    FROM post_stats s JOIN publications p ON p.id = s.publication_id
    WHERE p.account_id IN (${ids.map(() => "?").join(", ")}) AND p.day >= ? ORDER BY engagement DESC, COALESCE(s.views, s.impressions, 0) DESC LIMIT 10`).all(...ids, since) : [];
  return { days, accounts: rows, top };
}

/** Mesures du portefeuille pour un projet : abonnés (somme des comptes) et engagement des publications de la période. */
export function socialMeasures(project: { id: string; crm_key: string | null }, r: { from: string; to: string }, p: { from: string; to: string }) {
  const accounts = (db.prepare("SELECT id FROM pub_accounts WHERE project IN (?, ?)").all(project.id, project.crm_key ?? project.id) as Row[]).map((a) => a.id);
  if (!accounts.length) return {};
  const sum = (day: string) => { const v = accounts.map((id) => followersAt(id, day)).filter((x): x is number => x != null); return v.length ? v.reduce((a, b) => a + b, 0) : null; };
  const now = sum(r.to), before = sum(p.to);
  const ph = accounts.map(() => "?").join(", ");
  const eng = (range: { from: string; to: string }) => (db.prepare(`SELECT COUNT(s.publication_id) AS n, SUM(COALESCE(s.likes, 0) + COALESCE(s.comments, 0) + COALESCE(s.shares, 0)) AS e
    FROM publications pub LEFT JOIN post_stats s ON s.publication_id = pub.id WHERE pub.account_id IN (${ph}) AND pub.day BETWEEN ? AND ?`).get(...accounts, range.from, range.to) as Row);
  const en = eng(r), eb = eng(p);
  return {
    ...(now != null ? { followers: { value: now, previous: before, unit: null } } : {}),
    ...(en.n ? { engagement: { value: en.e ?? 0, previous: eb.n ? eb.e ?? 0 : null, unit: null } } : {}),
  };
}

export function registerSocialStats(app: Hono) {
  registerJob("publications", { id: "social-stats", every: "24h", run: () => collectAll() });
  app.get("/api/social-stats", (c) => {
    if (!isAdmin(c)) return c.json({ error: "Réservé à l'administrateur" }, 403);
    return c.json(socialStats({ project: c.req.query("project") || undefined, days: Number(c.req.query("days")) || 28 }));
  });
  app.post("/api/social-stats/refresh", async (c) => {
    if (!isAdmin(c)) return c.json({ error: "Réservé à l'administrateur" }, 403);
    await collectAll();
    return c.json(socialStats({ project: c.req.query("project") || undefined }));
  });
}

export function registerSocialTools(server: McpServer) {
  server.registerTool("social_stats", {
    description: "Statistiques des comptes de publication : abonnés et évolution, nombre de posts, vues, meilleures publications (j'aime, commentaires, partages). Chiffres lus une fois par jour sur les réseaux qui les fournissent.",
    inputSchema: z.object({ project: z.string().optional().describe("id ou clé du projet (obligatoire pour une clé limitée)"), days: z.number().int().min(1).max(365).default(28) }),
  }, async ({ project, days }) => ({ content: [{ type: "text" as const, text: JSON.stringify(socialStats({ project, days }), null, 2) }] }));
}
