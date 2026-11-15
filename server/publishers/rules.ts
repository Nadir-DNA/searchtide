// Actions sur seuil (plan D7) : « quand un post de ce compte atteint 100 j'aime, republier / commenter / prévenir ».
// Comparées aux statistiques relevées (D3), une seule fois par publication et par règle. Pas de like, d'abonnement ni de
// réponse automatique à des tiers : seulement des gestes sur ses propres posts. Une règle proposée par un agent reste
// désactivée jusqu'à ce que l'administrateur l'active.
import type { Hono } from "hono";
import type { McpServer } from "@modelcontextprotocol/server";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { db } from "../db.ts";
import { migrate } from "../migrations.ts";
import { registerJob } from "../jobs.ts";
import { isAdmin } from "../admin.ts";
import { savePublication } from "../business.ts";
import { addTodaySource, itemKey, type TodayItem } from "../today.ts";
import { queuePublication } from "./queue.ts";
import { mediaDir, mediaOf } from "./media.ts";
import { REPLIES } from "./followups.ts";
import { deliver } from "./automation.ts";
import "./stats.ts";

type Row = Record<string, any>;

migrate("2026-11-16-regles-de-seuil", `
CREATE TABLE pub_rules (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, metric TEXT NOT NULL, threshold INTEGER NOT NULL, action TEXT NOT NULL,
  text TEXT, delay_hours INTEGER NOT NULL DEFAULT 24, enabled INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE pub_rule_fires (rule_id TEXT NOT NULL, publication_id TEXT NOT NULL, at INTEGER NOT NULL, value INTEGER NOT NULL, result TEXT,
  PRIMARY KEY (rule_id, publication_id));`);

export const METRICS: Record<string, string> = { likes: "j'aime", comments: "commentaires", shares: "partages", views: "vues", impressions: "impressions", engagement: "interactions" };
export const ACTIONS: Record<string, string> = { repost: "republier", comment: "ajouter un commentaire", webhook: "prévenir par webhook", todo: "l'inscrire dans À traiter" };

const value = (s: Row, metric: string) => metric === "engagement"
  ? (s.likes == null && s.comments == null && s.shares == null ? null : (s.likes ?? 0) + (s.comments ?? 0) + (s.shares ?? 0))
  : s[metric] ?? null;

export function createRule(input: Row, by = "administrateur") {
  const account = db.prepare("SELECT * FROM pub_accounts WHERE id = ?").get(String(input.account_id ?? "")) as Row | undefined;
  if (!account) throw new Error("Compte de publication introuvable");
  const metric = String(input.metric ?? ""), action = String(input.action ?? "");
  if (!METRICS[metric]) throw new Error(`Mesure inconnue : ${metric}`);
  if (!ACTIONS[action]) throw new Error(`Action inconnue : ${action}`);
  const threshold = Math.round(Number(input.threshold));
  if (!(threshold >= 1 && threshold <= 100_000_000)) throw new Error("Seuil entre 1 et 100 000 000");
  const text = String(input.text ?? "").trim().slice(0, 5000) || null;
  if (action === "comment") {
    if (!text) throw new Error("Texte du commentaire requis");
    if (!REPLIES.has(String(account.network))) throw new Error(`Commentaire non pris en charge sur ${account.network}`);
  }
  // X refuse un post identique à un post récent : la republication y demande un nouveau texte.
  if (action === "repost" && account.network === "x" && !text) throw new Error("X refuse les doublons : donnez le texte de la republication");
  const delay = Math.min(Math.max(Math.round(Number(input.delay_hours ?? 24)), 1), 24 * 90);
  const id = randomUUID();
  const agent = by !== "administrateur";
  db.prepare("INSERT INTO pub_rules (id, account_id, metric, threshold, action, text, delay_hours, enabled, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, account.id, metric, threshold, action, text, delay, agent ? 0 : 1, by, Date.now());
  return db.prepare("SELECT * FROM pub_rules WHERE id = ?").get(id) as Row;
}

export const listRules = (accountIds?: string[]) => db.prepare(`SELECT r.*, a.label AS account_label, a.network, a.project,
    (SELECT COUNT(*) FROM pub_rule_fires f WHERE f.rule_id = r.id) AS fires
  FROM pub_rules r JOIN pub_accounts a ON a.id = r.account_id ${accountIds ? `WHERE r.account_id IN (${accountIds.map(() => "?").join(",") || "''"})` : ""} ORDER BY r.created_at`).all(...(accountIds ?? [])) as Row[];

/** Copie la publication (texte de la règle s'il est donné, mêmes médias) et la programme `delay` heures plus tard. */
async function repost(p: Row, rule: Row, now: number) {
  const copy = savePublication(null, { title: `${p.title} (republication)`, day: new Date(now + rule.delay_hours * 3_600_000).toISOString().slice(0, 10), project: p.project, network: p.network, text: rule.text || p.text, account_id: p.account_id, visible: p.visible ?? null }) as Row;
  const dir = join(mediaDir(), copy.id); let made = false;
  for (const m of mediaOf(String(p.id)) as Row[]) {
    if (!made) { mkdirSync(dir, { recursive: true }); made = true; }
    const path = join(dir, `${randomUUID()}`);
    copyFileSync(String(m.path), path);
    db.prepare("INSERT INTO pub_media (id, publication_id, name, mime, size, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), copy.id, m.name, m.mime, m.size, path, Date.now());
  }
  await queuePublication(copy.id, { at: now + rule.delay_hours * 3_600_000 }, now);
  return `republication programmée (${copy.id})`;
}

/** Évalue toutes les règles actives. `now` remplaçable dans les tests. */
export async function evaluateRules(now = Date.now()) {
  const rules = db.prepare("SELECT r.*, a.network FROM pub_rules r JOIN pub_accounts a ON a.id = r.account_id WHERE r.enabled = 1").all() as Row[];
  let fired = 0;
  for (const rule of rules) {
    // Seules les publications parues après la création de la règle, sur 30 jours : pas d'effet rétroactif en rafale.
    const pubs = db.prepare(`SELECT p.*, s.likes, s.comments, s.shares, s.views, s.impressions FROM publications p JOIN post_stats s ON s.publication_id = p.id
      WHERE p.account_id = ? AND p.state = 'published' AND COALESCE(p.published_at, p.updated_at) >= ? AND COALESCE(p.published_at, p.updated_at) >= ?
      AND NOT EXISTS (SELECT 1 FROM pub_rule_fires f WHERE f.rule_id = ? AND f.publication_id = p.id)`).all(rule.account_id, rule.created_at, now - 30 * 86_400_000, rule.id) as Row[];
    for (const p of pubs) {
      const v = value(p, rule.metric);
      if (v == null || v < rule.threshold) continue;
      // Déclenchement réservé avant le geste : une règle ne part jamais deux fois pour la même publication.
      const claimed = db.prepare("INSERT OR IGNORE INTO pub_rule_fires (rule_id, publication_id, at, value) VALUES (?, ?, ?, ?)").run(rule.id, p.id, now, v);
      if (!claimed.changes) continue;
      let result: string;
      try {
        if (rule.action === "repost") result = await repost(p, rule, now);
        else if (rule.action === "comment") {
          const idx = Number((db.prepare("SELECT COALESCE(MAX(idx), 0) AS n FROM pub_followups WHERE publication_id = ?").get(p.id) as Row).n) + 1;
          db.prepare("INSERT INTO pub_followups (publication_id, idx, kind, text) VALUES (?, ?, 'comment', ?)").run(p.id, idx, rule.text);
          result = "commentaire en file";
        } else if (rule.action === "webhook") {
          await deliver("threshold", { id: p.id, title: p.title, network: p.network, project: p.project, url: p.evidence_url, metric: rule.metric, value: v, threshold: rule.threshold });
          result = "webhook envoyé";
        } else result = "inscrit dans À traiter";
      } catch (e) { result = `échec : ${(e as Error).message}`; }
      db.prepare("UPDATE pub_rule_fires SET result = ? WHERE rule_id = ? AND publication_id = ?").run(result.slice(0, 300), rule.id, p.id);
      fired++;
    }
  }
  return fired;
}

/** Seuils atteints (14 derniers jours) dans « À traiter » : ceux dont l'action est d'y être inscrits, et les échecs. */
function thresholdItems(): TodayItem[] {
  const rows = db.prepare(`SELECT f.*, r.metric, r.threshold, r.action, p.title, p.project, p.evidence_url, pr.id AS project_id, pr.name AS project_name
    FROM pub_rule_fires f JOIN pub_rules r ON r.id = f.rule_id JOIN publications p ON p.id = f.publication_id
    LEFT JOIN projects pr ON pr.id = p.project OR pr.crm_key = p.project
    WHERE f.at >= ? AND (r.action = 'todo' OR f.result LIKE 'échec%')`).all(Date.now() - 14 * 86_400_000) as Row[];
  return rows.map((r) => ({
    key: itemKey("seuil", r.rule_id, r.publication_id), kind: "action", tone: String(r.result ?? "").startsWith("échec") ? "warn" : "info", project_id: r.project_id ?? null,
    text: `${r.project_name ? `${r.project_name} · ` : ""}« ${r.title} » a atteint ${r.value} ${METRICS[r.metric]} (seuil ${r.threshold})${String(r.result ?? "").startsWith("échec") ? ` : ${ACTIONS[r.action]} a échoué` : ""}`,
    to: { view: "pubs" },
  }));
}
addTodaySource(thresholdItems);

export function registerRules(app: Hono) {
  registerJob("publications", { id: "regles-seuil", every: "1h", run: async () => { await evaluateRules(); } });
  const admin = (c: any) => isAdmin(c) ? null : c.json({ error: "Réservé à l'administrateur" }, 403);
  app.get("/api/pub-rules", (c) => admin(c) ?? c.json(listRules()));
  app.post("/api/pub-rules", async (c) => {
    const denied = admin(c); if (denied) return denied;
    try { return c.json(createRule(await c.req.json().catch(() => ({}))), 201); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });
  app.patch("/api/pub-rules/:id", async (c) => {
    const denied = admin(c); if (denied) return denied;
    const b = await c.req.json().catch(() => ({}));
    const n = db.prepare("UPDATE pub_rules SET enabled = ? WHERE id = ?").run(b.enabled ? 1 : 0, c.req.param("id")).changes;
    return n ? c.json(db.prepare("SELECT * FROM pub_rules WHERE id = ?").get(c.req.param("id"))) : c.json({ error: "Règle introuvable" }, 404);
  });
  app.delete("/api/pub-rules/:id", (c) => {
    const denied = admin(c); if (denied) return denied;
    db.prepare("DELETE FROM pub_rule_fires WHERE rule_id = ?").run(c.req.param("id"));
    return c.json({ ok: db.prepare("DELETE FROM pub_rules WHERE id = ?").run(c.req.param("id")).changes > 0 });
  });
}

/** Outils d'agent : lire les règles d'un projet ; en proposer une, qui reste désactivée jusqu'à l'accord de l'administrateur. */
export function registerRuleTools(server: McpServer, readOnly: boolean, agent: string) {
  const accountsOf = (project: string) => (db.prepare("SELECT a.id FROM pub_accounts a JOIN projects p ON a.project IN (p.id, p.crm_key) WHERE p.id = ? OR p.crm_key = ?").all(project, project) as Row[]).map((r) => String(r.id));
  server.registerTool("pub_rules", {
    description: "Règles de seuil des comptes de publication d'un projet (ex. à 100 j'aime : republier) et leurs déclenchements.",
    inputSchema: z.object({ project: z.string().describe("id ou clé du projet") }),
  }, async ({ project }) => ({ content: [{ type: "text" as const, text: JSON.stringify(listRules(accountsOf(project)), null, 2) }] }));
  if (readOnly) return;
  server.registerTool("pub_rule_propose", {
    description: "Propose une règle de seuil sur un compte de publication. Elle reste désactivée tant que l'administrateur ne l'a pas activée dans Publications → Automatisations. Actions : repost, comment, webhook, todo. Mesures : likes, comments, shares, views, impressions, engagement.",
    inputSchema: z.object({
      project: z.string().describe("id ou clé du projet du compte"), account_id: z.string(),
      metric: z.enum(["likes", "comments", "shares", "views", "impressions", "engagement"]), threshold: z.number().int().min(1),
      action: z.enum(["repost", "comment", "webhook", "todo"]), text: z.string().max(5000).optional(), delay_hours: z.number().int().min(1).max(2160).optional(),
    }),
  }, async (a) => {
    if (!accountsOf(a.project).includes(a.account_id)) throw new Error("Introuvable");
    const r = createRule(a, agent);
    return { content: [{ type: "text" as const, text: JSON.stringify({ ...r, note: "Règle désactivée : l'administrateur doit l'activer." }, null, 2) }] };
  });
}
