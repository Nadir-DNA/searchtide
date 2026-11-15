// Premier commentaire, fils et hashtags (plan D6). Une fois la publication en ligne, ses suites partent une par une
// comme réponses : chaque partie d'un fil répond à la précédente, le premier commentaire répond au post. Chaque suite
// a son propre état ; un doute (« à vérifier ») n'est jamais rejoué, et une partie manquante arrête le reste du fil.
import type { Hono } from "hono";
import { db } from "../db.ts";
import { migrate } from "../migrations.ts";
import { registerJob } from "../jobs.ts";
import { isAdmin } from "../admin.ts";
import { providerFor, type PublishResult } from "./provider.ts";
import { credentialsFor } from "./tokens.ts";
import { NETWORK_LIMITS, addPublicationCheck, onPublicationEvent } from "./queue.ts";
import "../business.ts"; // table publications

type Row = Record<string, any>;

migrate("2026-11-16-suites-de-publication", `
ALTER TABLE publications ADD COLUMN first_comment TEXT;
ALTER TABLE publications ADD COLUMN thread TEXT;
CREATE TABLE pub_followups (
  id INTEGER PRIMARY KEY AUTOINCREMENT, publication_id TEXT NOT NULL, idx INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending', url TEXT, detail TEXT, at INTEGER, UNIQUE (publication_id, idx));
CREATE TABLE project_hashtags (project TEXT NOT NULL, network TEXT NOT NULL, tags TEXT NOT NULL, PRIMARY KEY (project, network));`);

/** Réseaux qui acceptent une réponse par API (premier commentaire) ; ceux qui affichent un fil sous le post. */
export const REPLIES = new Set(["x", "linkedin", "facebook", "instagram", "reddit"]);
export const THREADS = new Set(["x"]);
/** Plafonds de hashtags : Instagram refuse au-delà de 30 ; ailleurs, au-delà du conseil, la portée baisse. */
export const HASHTAGS: Record<string, { max?: number; advised: number }> = {
  instagram: { max: 30, advised: 5 }, x: { advised: 2 }, linkedin: { advised: 3 }, tiktok: { advised: 5 }, facebook: { advised: 3 }, youtube: { max: 60, advised: 3 }, pinterest: { advised: 5 },
};
export const countHashtags = (text: string) => (text.match(/(^|\s)#[\p{L}\p{N}_]+/gu) ?? []).length;

const parseThread = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  try { return v ? parseThread(JSON.parse(String(v))) : []; } catch { return []; }
};

/** Ce que les suites d'une publication ont de refusable, avant toute mise en file. */
export function followupIssues(p: Row, account: Row | undefined): string[] {
  const network = String(p.network ?? ""), issues: string[] = [];
  const comment = String(p.first_comment ?? "").trim(), parts = parseThread(p.thread);
  const real = account?.connection_id ? providerFor(network) : undefined;
  const web = account?.mode === "web";
  const max = real?.limits.text ?? NETWORK_LIMITS[network]?.text;
  if (comment) {
    if (web) issues.push("Premier commentaire : pas encore pris en charge par la publication navigateur");
    else if (!REPLIES.has(network) || (real && !real.reply)) issues.push(`Premier commentaire non pris en charge sur ${network}`);
    if (max && comment.length > max) issues.push(`Premier commentaire trop long : ${comment.length} / ${max}`);
  }
  if (parts.length) {
    if (web) issues.push("Fil : pas encore pris en charge par la publication navigateur");
    else if (!THREADS.has(network)) issues.push(`Fil non pris en charge sur ${network} : publiez un seul post`);
    if (parts.length > 24) issues.push("Fil de 25 parties au plus");
    parts.forEach((t, i) => { if (max && t.length > max) issues.push(`Partie ${i + 2} du fil trop longue : ${t.length} / ${max}`); });
  }
  const tags = countHashtags(String(p.text ?? "")), rule = HASHTAGS[network];
  if (rule?.max && tags > rule.max) issues.push(`${network} : ${tags} hashtags, ${rule.max} au plus`);
  return issues;
}

addPublicationCheck(followupIssues);

/** Enregistre premier commentaire et fil d'un brouillon. Une publication déjà en file reste figée. */
export function setFollowups(id: string, input: { first_comment?: unknown; thread?: unknown }) {
  const p = db.prepare("SELECT * FROM publications WHERE id = ?").get(id) as Row | undefined;
  if (!p) throw new Error("Publication introuvable");
  if (["scheduled", "running", "processing", "published"].includes(String(p.state))) throw new Error("Publication déjà en file : annulez-la pour modifier ses suites");
  const comment = String(input.first_comment ?? "").trim().slice(0, 10_000) || null;
  const parts = parseThread(input.thread).slice(0, 25);
  db.prepare("UPDATE publications SET first_comment = ?, thread = ?, updated_at = ? WHERE id = ?").run(comment, parts.length ? JSON.stringify(parts) : null, Date.now(), id);
  return db.prepare("SELECT * FROM publications WHERE id = ?").get(id) as Row;
}

/** À la mise en ligne : les suites deviennent des envois en attente (une seule fois, même si l'événement se répète). */
export function planFollowups(pubId: string) {
  const p = db.prepare("SELECT first_comment, thread FROM publications WHERE id = ?").get(pubId) as Row | undefined;
  if (!p) return 0;
  const parts = parseThread(p.thread);
  const rows: [string, string][] = [...parts.map((t) => ["thread", t] as [string, string]), ...(p.first_comment ? [["comment", String(p.first_comment)] as [string, string]] : [])];
  const ins = db.prepare("INSERT OR IGNORE INTO pub_followups (publication_id, idx, kind, text) VALUES (?, ?, ?, ?)");
  rows.forEach(([kind, text], i) => ins.run(pubId, i + 1, kind, text));
  return rows.length;
}

type Reply = (account: Row, parentUrl: string, text: string) => Promise<PublishResult>;

/** Réponse par le fournisseur réel ; compte de test : adresse simulée. */
const replyWith: Reply = async (account, parentUrl, text) => {
  if (!account.connection_id) return text.includes("[fail]") ? { ok: false, kind: "refused", message: "Réponse refusée (simulation)" } : { ok: true, url: `${parentUrl}#r${Date.now().toString(36)}` };
  const provider = providerFor(String(account.network));
  if (!provider?.reply) return { ok: false, kind: "format", message: "Réponses non prises en charge sur ce réseau" };
  const cred = await credentialsFor(account);
  if (!cred.ok) return { ok: false, kind: "auth", message: cred.message };
  return provider.reply(parentUrl, text, cred.token, cred.accountId);
};

/** Envoie les suites en attente des publications en ligne, dans l'ordre. `reply` est remplaçable dans les tests. */
export async function runFollowups(reply: Reply = replyWith): Promise<number> {
  // Une suite « en cours » au redémarrage a peut-être été publiée : à vérifier, jamais renvoyée.
  db.prepare("UPDATE pub_followups SET state = 'to_verify', detail = 'interrompue : vérifiez sur le réseau' WHERE state = 'running' AND at < ?").run(Date.now() - 10 * 60_000);
  const pubs = db.prepare(`SELECT DISTINCT p.* FROM pub_followups f JOIN publications p ON p.id = f.publication_id
    WHERE f.state = 'pending' AND p.state = 'published' AND p.evidence_url IS NOT NULL LIMIT 20`).all() as Row[];
  let sent = 0;
  for (const p of pubs) {
    const account = db.prepare("SELECT * FROM pub_accounts WHERE id = ?").get(p.account_id) as Row | undefined;
    const rows = db.prepare("SELECT * FROM pub_followups WHERE publication_id = ? ORDER BY idx").all(p.id) as Row[];
    let previous = String(p.evidence_url);
    for (const f of rows) {
      if (f.kind === "thread" && f.state !== "pending") {
        if (f.state === "sent" && f.url) { previous = String(f.url); continue; }
        break;   // une partie manquante : le reste du fil attend la décision de l'utilisateur
      }
      if (f.state !== "pending") continue;
      const parent = f.kind === "thread" ? previous : String(p.evidence_url);
      const claimed = db.prepare("UPDATE pub_followups SET state = 'running', at = ? WHERE id = ? AND state = 'pending'").run(Date.now(), f.id);
      if (!claimed.changes) continue;
      let r: PublishResult;
      if (!account) r = { ok: false, kind: "format", message: "Compte de publication retiré" };
      else { try { r = await reply(account, parent, String(f.text)); } catch (e) { r = { ok: false, kind: "to_verify", message: `résultat incertain : ${(e as Error).message}` }; } }
      const state = r.ok ? "sent" : r.kind === "to_verify" || r.kind === "pending" ? "to_verify" : "failed";
      db.prepare("UPDATE pub_followups SET state = ?, url = ?, detail = ?, at = ? WHERE id = ?").run(state, r.ok ? r.url : null, r.ok ? null : r.message.slice(0, 300), Date.now(), f.id);
      db.prepare("INSERT INTO pub_attempts (publication_id, ts, state, detail, evidence_url) VALUES (?, ?, ?, ?, ?)")
        .run(p.id, Date.now(), "followup", `${f.kind === "thread" ? `fil, partie ${f.idx + 1}` : "premier commentaire"} : ${r.ok ? "envoyé" : r.message}`.slice(0, 500), r.ok ? r.url : null);
      if (!r.ok) { if (f.kind === "thread") break; continue; }
      sent++;
      if (f.kind === "thread") previous = r.url;
    }
  }
  return sent;
}

export const followupsOf = (pubId: string) => db.prepare("SELECT idx, kind, text, state, url, detail, at FROM pub_followups WHERE publication_id = ? ORDER BY idx").all(pubId);

/** Une suite en échec (rien n'est parti) peut repartir ; une suite « à vérifier » se résout à la main. */
export function retryFollowup(pubId: string, idx: number, outcome?: "sent" | "pending", url?: string) {
  const f = db.prepare("SELECT * FROM pub_followups WHERE publication_id = ? AND idx = ?").get(pubId, idx) as Row | undefined;
  if (!f) throw new Error("Suite introuvable");
  if (f.state === "failed") db.prepare("UPDATE pub_followups SET state = 'pending', detail = NULL WHERE id = ?").run(f.id);
  else if (f.state === "to_verify" && outcome === "sent") db.prepare("UPDATE pub_followups SET state = 'sent', url = ?, detail = 'confirmée à la main' WHERE id = ?").run(url || null, f.id);
  else if (f.state === "to_verify" && outcome === "pending") db.prepare("UPDATE pub_followups SET state = 'pending', detail = NULL WHERE id = ?").run(f.id);
  else throw new Error("Seule une suite en échec ou à vérifier peut être reprise");
  return followupsOf(pubId);
}

export function hashtagsOf(project: string) {
  return Object.fromEntries((db.prepare("SELECT network, tags FROM project_hashtags WHERE project = ?").all(project) as Row[]).map((r) => [r.network, r.tags]));
}
export function setHashtags(project: string, network: string, tags: string) {
  const clean = [...new Set(String(tags ?? "").split(/[\s,]+/).map((t) => t.replace(/^#*/, "")).filter((t) => /^[\p{L}\p{N}_]{1,60}$/u.test(t)))].slice(0, 30).map((t) => `#${t}`).join(" ");
  if (!project || !network) throw new Error("Projet et réseau requis");
  if (clean) db.prepare("INSERT INTO project_hashtags (project, network, tags) VALUES (?, ?, ?) ON CONFLICT(project, network) DO UPDATE SET tags = excluded.tags").run(project, network, clean);
  else db.prepare("DELETE FROM project_hashtags WHERE project = ? AND network = ?").run(project, network);
  return hashtagsOf(project);
}

onPublicationEvent((e) => { if (e.state === "published") planFollowups(e.id); });

export function registerFollowups(app: Hono) {
  registerJob("publications", { id: "publications-suites", every: "1m", run: async () => { await runFollowups(); } });
  const admin = (c: any) => isAdmin(c) ? null : c.json({ error: "Réservé à l'administrateur" }, 403);
  app.get("/api/publications/:id/followups", (c) => admin(c) ?? c.json(followupsOf(c.req.param("id"))));
  app.put("/api/publications/:id/followups", async (c) => {
    const denied = admin(c); if (denied) return denied;
    try { return c.json(setFollowups(c.req.param("id"), await c.req.json().catch(() => ({})))); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });
  app.post("/api/publications/:id/followups/:idx", async (c) => {
    const denied = admin(c); if (denied) return denied;
    const b = await c.req.json().catch(() => ({}));
    try { return c.json(retryFollowup(c.req.param("id"), Number(c.req.param("idx")), b.outcome, typeof b.url === "string" ? b.url : undefined)); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });
  app.get("/api/hashtags", (c) => admin(c) ?? c.json(hashtagsOf(String(c.req.query("project") ?? ""))));
  app.put("/api/hashtags", async (c) => {
    const denied = admin(c); if (denied) return denied;
    const b = await c.req.json().catch(() => ({}));
    try { return c.json(setHashtags(String(b.project ?? ""), String(b.network ?? ""), String(b.tags ?? ""))); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });
}
