// L1 tranche 2 : approbations génériques (action, projet, charge utile), admin seul, usage unique atomique.
import { createHash, randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { db } from "./db.ts";
import { isAdmin } from "./admin.ts";
import { securityEvent } from "./security-events.ts";
import { canAccess, type AgentIdentity } from "./agents.ts";
import { SECRET_CONFIG_ERROR, hasSecretKey, maskSecrets } from "./mask.ts";
import { maskLegacyConfig, validateIndicatorConfig } from "./projects.ts";

type Row = Record<string, any>;
db.exec(`CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, project_id TEXT NOT NULL, action TEXT NOT NULL,
  payload_hash TEXT NOT NULL, before TEXT, after TEXT, expires_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending', used INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  target_id TEXT, payload TEXT
)`);
try { db.exec("ALTER TABLE approvals ADD COLUMN target_id TEXT"); } catch { /* déjà présent */ }
try { db.exec("ALTER TABLE approvals ADD COLUMN payload TEXT"); } catch { /* déjà présent */ }
const MAX_PENDING = 20, TTL = 86_400_000;

const canonical = (v: unknown): string => {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v as Row).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Row)[k])}`).join(",")}}`;
};
export const payloadHash = (action: string, projectId: string, targetId: string | null, payload: unknown) =>
  createHash("sha256").update(`${action}|${projectId}|${targetId ?? ""}|${canonical(payload)}`).digest("hex");
/** Ajoute les libellés lisibles (projet, cible, agent) : l'admin approuve une demande compréhensible, sans HTML. */
function enrich(rows: Row[]): Row[] {
  const projectName = new Map((db.prepare("SELECT id, name FROM projects").all() as Row[]).map((p) => [p.id, p.name]));
  const agentName = new Map((db.prepare("SELECT id, name FROM agent_keys").all() as Row[]).map((a) => [a.id, a.name]));
  const label = new Map((db.prepare("SELECT id, label FROM indicators").all() as Row[]).map((i) => [i.id, i.label]));
  const removed = (before: string | null, after: string | null): string[] => {
    try {
      const b = JSON.parse(before ?? "null")?.config, a = JSON.parse(after ?? "null")?.config;
      return b && a && typeof b === "object" && typeof a === "object" ? Object.keys(b).filter((k) => !(k in a)) : [];
    } catch { return []; }
  };
  return rows.map((r) => ({
    ...r,
    project_name: projectName.get(r.project_id) ?? r.project_id,
    target_label: r.target_id ? label.get(r.target_id) ?? "cible absente" : null,
    agent_name: r.agent_id ? agentName.get(r.agent_id) ?? "clé supprimée" : "administrateur",
    removed: removed(r.before, r.after),
  }));
}

function maskedPayload(value: unknown): string {
  return JSON.stringify(maskSecrets(value)).slice(0, 256 * 1024);
}

export function createApproval(agentId: string, b: Row) {
  // Une demande expirée ne bloque plus le plafond ni la déduplication.
  db.prepare("UPDATE approvals SET state = 'expired' WHERE state = 'pending' AND expires_at <= ?").run(Date.now());
  const action = String(b.action ?? "").slice(0, 80);
  const projectId = String(b.project_id ?? "");
  if (!action || !projectId || b.payload === undefined) throw new Error("action, project_id et payload requis");
  if (action === "indicator_source" && hasSecretKey(b.payload)) throw new Error(SECRET_CONFIG_ERROR);
  const json = JSON.stringify(b.payload);
  if (json.length > 256 * 1024) throw new Error("Charge utile trop volumineuse (256 Ko maximum)");
  const depth = (v: unknown, n = 0): number => v && typeof v === "object" ? 1 + Math.max(0, ...Object.values(v as Row).map((x) => depth(x, n + 1))) : 0;
  if (depth(b.payload) > 20) throw new Error("Charge utile trop profonde (20 niveaux maximum)");
  if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) throw new Error("Projet introuvable");
  const targetId = b.target_id == null ? null : String(b.target_id);
  let before = b.before, after = b.after;
  if (action === "indicator_source") {
    if (!targetId) throw new Error("target_id requis pour indicator_source");
    const ind = db.prepare("SELECT project_id, source, config, label FROM indicators WHERE id = ?").get(targetId) as Row | undefined;
    if (!ind || ind.project_id !== projectId) throw new Error("Indicateur introuvable");
    const current = { source: String(ind.source), config: JSON.parse(String(ind.config)) };
    const patch = b.payload && typeof b.payload === "object" ? b.payload as Row : {};
    const nextSource = String(patch.source ?? current.source);
    // Sémantique de REMPLACEMENT, identique à saveIndicator : un patch partiel ne fusionne pas.
    // L'aperçu montre donc exactement ce qui sera écrit, y compris les champs supprimés (env, path…).
    const hasConfig = Object.prototype.hasOwnProperty.call(patch, "config");
    const nextConfig = hasConfig ? patch.config : current.config;
    const validated = validateIndicatorConfig(nextSource as any, nextConfig);
    before = { source: current.source, config: maskLegacyConfig(current.source, current.config) };
    after = { source: nextSource, config: maskLegacyConfig(nextSource, validated) };
  }
  if (action === "project_delete") {
    // Suppression d'un projet gardée : l'admin voit le nom, les sites et le nombre d'indicateurs.
    if (!targetId || targetId !== projectId) throw new Error("target_id doit être le projet à supprimer");
    const proj = db.prepare("SELECT name, sites FROM projects WHERE id = ?").get(targetId) as Row | undefined;
    if (!proj) throw new Error("Projet introuvable");
    const count = (db.prepare("SELECT COUNT(*) AS n FROM indicators WHERE project_id = ?").get(targetId) as { n: number }).n;
    let sites: string[] = [];
    try { sites = JSON.parse(String(proj.sites)); } catch { /* sites illisibles */ }
    before = { name: proj.name, sites, indicators: count };
    after = null;
  }
  if (action === "indicator_delete") {
    // Suppression gardée : l'admin voit exactement la cible et sa config masquée avant d'approuver.
    if (!targetId) throw new Error("target_id requis pour indicator_delete");
    const ind = db.prepare("SELECT project_id, source, config, label, unit FROM indicators WHERE id = ?").get(targetId) as Row | undefined;
    if (!ind || ind.project_id !== projectId) throw new Error("Indicateur introuvable");
    before = { label: ind.label, unit: ind.unit ?? null, source: ind.source, config: maskLegacyConfig(String(ind.source), JSON.parse(String(ind.config))) };
    after = null;
  }
  const hash = payloadHash(action, projectId, targetId, b.payload);
  const dup = db.prepare("SELECT id FROM approvals WHERE agent_id = ? AND payload_hash = ? AND state = 'pending' AND expires_at > ?").get(agentId, hash, Date.now()) as { id: string } | undefined;
  if (dup) return { id: dup.id, duplicate: true };
  const pending = (db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE agent_id = ? AND state = 'pending' AND expires_at > ?").get(agentId, Date.now()) as { n: number }).n;
  if (pending >= MAX_PENDING) throw new Error("Plafond de 20 demandes en attente atteint");
  const id = randomUUID();
  db.prepare(`INSERT INTO approvals (id, agent_id, project_id, action, payload_hash, before, after, expires_at, created_at, target_id, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, agentId, projectId, action, hash,
    before === undefined ? null : maskedPayload(before).slice(0, 2000),
    after === undefined ? null : maskedPayload(after).slice(0, 2000), Date.now() + TTL, Date.now(), targetId, maskedPayload(b.payload));
  securityEvent("approval_created", action);
  return { id, duplicate: false };
}

export function decideApproval(id: string, state: "approved" | "rejected") {
  const r = db.prepare("UPDATE approvals SET state = ? WHERE id = ? AND state = 'pending' AND expires_at > ?").run(state, id, Date.now());
  if (Number(r.changes) !== 1) return false;
  securityEvent(state === "approved" ? "approval_approved" : "approval_rejected", id);
  return true;
}

/** Vérifie sans consommer : même contrôles que consumeApproval, aucun changement d'état. */
export function verifyApproval(id: string, opts: { agentId: string; action: string; projectId: string; targetId?: string | null; payload: unknown }): "ok" | "missing" | "hash" | "state" {
  const row = db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as Row | undefined;
  if (!row) return "missing";
  if (row.agent_id !== opts.agentId || row.action !== opts.action || row.project_id !== opts.projectId || (row.target_id ?? null) !== (opts.targetId ?? null)) return "hash";
  if (payloadHash(opts.action, opts.projectId, opts.targetId ?? null, opts.payload) !== row.payload_hash) return "hash";
  if (row.state !== "approved" || row.used || Number(row.expires_at) <= Date.now()) return "state";
  return "ok";
}

/** Consommation atomique : payload recalculé, état approuvé, non utilisé, non expiré. */
export function consumeApproval(id: string, opts: { agentId: string; action: string; projectId: string; targetId?: string | null; payload: unknown }): "ok" | "missing" | "hash" | "state" {
  const row = db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as Row | undefined;
  if (!row) return "missing";
  if (row.agent_id !== opts.agentId || row.action !== opts.action || row.project_id !== opts.projectId || (row.target_id ?? null) !== (opts.targetId ?? null)) { securityEvent("approval_refused", "cible"); return "hash"; }
  if (payloadHash(opts.action, opts.projectId, opts.targetId ?? null, opts.payload) !== row.payload_hash) { securityEvent("approval_refused", "hash"); return "hash"; }
  const r = db.prepare("UPDATE approvals SET used = 1, state = 'consumed' WHERE id = ? AND state = 'approved' AND used = 0 AND expires_at > ?").run(id, Date.now());
  if (Number(r.changes) !== 1) { securityEvent("approval_refused", "state"); return "state"; }
  securityEvent("approval_consumed", id);
  return "ok";
}

export function registerApprovals(app: Hono) {
  app.post("/api/approvals", async (c) => {
    const agent = (c as any).get("agent") as AgentIdentity | undefined;
    if (!agent) return c.json({ error: "Réservé à une clé d'agent" }, 403);
    const b = await c.req.json().catch(() => ({}));
    const pid = String(b.project_id ?? "");
    // Hors portée et inexistant : même réponse, aucune fuite.
    if (!pid || !db.prepare("SELECT 1 FROM projects WHERE id = ?").get(pid) || !canAccess(agent, pid, "read")) return c.json({ error: "Introuvable" }, 404);
    try { return c.json(createApproval(agent.id, b), 201); }
    catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });
  app.get("/api/approvals", (c) => {
    db.prepare("UPDATE approvals SET state = 'expired' WHERE state = 'pending' AND expires_at <= ?").run(Date.now());
    if (isAdmin(c)) return c.json(enrich(db.prepare("SELECT id, agent_id, project_id, action, target_id, payload, before, after, expires_at, state, used, created_at FROM approvals ORDER BY id DESC LIMIT 200").all() as Row[]));
    const agent = (c as any).get("agent");
    if (!agent) return c.json({ error: "Non autorisé" }, 401);
    return c.json(enrich(db.prepare("SELECT id, project_id, action, target_id, payload, before, after, expires_at, state, used, created_at FROM approvals WHERE agent_id = ? ORDER BY id DESC").all(agent.id) as Row[]));
  });
  app.post("/api/approvals/:id/approve", (c) => isAdmin(c) ? (decideApproval(c.req.param("id"), "approved") ? c.json({ ok: true }) : c.json({ error: "Demande absente, expirée ou déjà traitée" }, 409)) : c.json({ error: "Réservé à l'administrateur" }, 403));
  app.post("/api/approvals/:id/reject", (c) => isAdmin(c) ? (decideApproval(c.req.param("id"), "rejected") ? c.json({ ok: true }) : c.json({ error: "Demande absente, expirée ou déjà traitée" }, 409)) : c.json({ error: "Réservé à l'administrateur" }, 403));

}
