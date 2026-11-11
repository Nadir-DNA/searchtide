// L2 phase 1 : socle de publication sans réseau réel — comptes, brouillons, file persistante,
// tâche d'une minute, états, tentatives et preuve. Fournisseur factice uniquement.
import type { Hono } from "hono";
import { createHash, randomUUID } from "node:crypto";
import { db } from "../db.ts";
import { migrate } from "../migrations.ts";
import { registerJob } from "../jobs.ts";
import { isAdmin } from "../admin.ts";
import { securityEvent } from "../security-events.ts";
import { mediaOf } from "./media.ts";
import { publicationBinding, publishWithBrowser } from "../browser/runner.ts";
import { createApproval, decideApproval } from "../approvals.ts";

type Row = Record<string, any>;

db.exec(`CREATE TABLE IF NOT EXISTS pub_accounts (
  id TEXT PRIMARY KEY, project TEXT NOT NULL, network TEXT NOT NULL, label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'connected', daily_cap INTEGER NOT NULL DEFAULT 3, created_at INTEGER NOT NULL
)`);
for (const sql of [
  "ALTER TABLE pub_accounts ADD COLUMN mode TEXT NOT NULL DEFAULT 'api'",
  "ALTER TABLE pub_accounts ADD COLUMN web_url TEXT",
  "ALTER TABLE pub_accounts ADD COLUMN fixture_port INTEGER",
  "ALTER TABLE publications ADD COLUMN approval_id TEXT",
]) { try { db.exec(sql); } catch { /* colonne déjà présente */ } }
db.exec(`CREATE TABLE IF NOT EXISTS pub_idempotency (
  key TEXT PRIMARY KEY, url TEXT NOT NULL, at INTEGER NOT NULL
)`);
db.exec(`CREATE TABLE IF NOT EXISTS pub_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, publication_id TEXT NOT NULL, ts INTEGER NOT NULL,
  state TEXT NOT NULL, detail TEXT, evidence_url TEXT
)`);

export const PUB_STATES = ["draft", "scheduled", "running", "published", "failed", "needs_action", "to_verify", "missed", "cancelled"] as const;
export type PubState = typeof PUB_STATES[number];
export const NETWORK_LIMITS: Record<string, { text: number; media: number; needsTitle?: boolean; needsVisibility?: boolean }> = {
  x: { text: 280, media: 4 },
  instagram: { text: 2200, media: 10 },
  facebook: { text: 63_206, media: 10 },
  tiktok: { text: 2200, media: 35, needsVisibility: true },
  youtube: { text: 5000, media: 1, needsTitle: true },
  linkedin: { text: 3000, media: 9 },
};
export const MAX_LATE_MS = 2 * 60 * 60_000;

const nowIso = () => new Date().toISOString();

/** Un compte de publication, par projet et par réseau. Phase 1 : factice, aucun secret. */
export function listAccounts(project?: string) {
  return db.prepare(`SELECT a.*, (SELECT COUNT(*) FROM publications p WHERE p.account_id = a.id) AS publications
    FROM pub_accounts a ${project ? "WHERE a.project = ?" : ""} ORDER BY a.project, a.network`).all(...(project ? [project] : [])) as Row[];
}
export function createAccount(input: { project?: string; network?: string; label?: string; daily_cap?: number; mode?: string; web_url?: string }) {
  const project = String(input.project ?? "").trim();
  const network = String(input.network ?? "").trim();
  const label = String(input.label ?? "").trim().slice(0, 80);
  if (!project) throw new Error("Projet requis");
  if (!NETWORK_LIMITS[network]) throw new Error(`Réseau non pris en charge : ${network || "(vide)"}`);
  if (!label) throw new Error("Nom du compte requis");
  const cap = Math.min(Math.max(Number(input.daily_cap) || 3, 1), 100);
  const mode = input.mode === "web" ? "web" : "api";
  let webUrl: string | null = null, fixturePort: number | null = null;
  if (mode === "web") {
    try { const u = new URL(String(input.web_url ?? "")); if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(); webUrl = u.toString(); fixturePort = Number(u.port) || null; }
    catch { throw new Error("Adresse de connexion (http ou https) requise pour un compte navigateur"); }
  }
  const id = randomUUID();
  db.prepare("INSERT INTO pub_accounts (id, project, network, label, daily_cap, mode, web_url, fixture_port, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, project, network, label, cap, mode, webUrl, fixturePort, Date.now());
  return db.prepare("SELECT * FROM pub_accounts WHERE id = ?").get(id);
}
export function deleteAccount(id: string) {
  const a = db.prepare("SELECT * FROM pub_accounts WHERE id = ?").get(id) as Row | undefined;
  if (!a) return false;
  // Révocation : les publications encore programmées de ce compte sont annulées, jamais envoyées.
  db.prepare("UPDATE publications SET state = 'cancelled', updated_at = ? WHERE account_id = ? AND state IN ('scheduled', 'draft')").run(Date.now(), id);
  db.prepare("DELETE FROM pub_accounts WHERE id = ?").run(id);
  securityEvent("approval_refused", `compte de publication supprimé : ${a.network}`);
  return true;
}

/** Règles officielles de la phase 1 (texte) ; les médias viendront avec le stockage vérifié. */
export function validatePublication(p: Row, account: Row | undefined): string[] {
  const issues: string[] = [];
  const network = String(p.network ?? "");
  const limit = NETWORK_LIMITS[network];
  if (!limit) issues.push(`Réseau non pris en charge : ${network || "(vide)"}`);
  if (!account) issues.push("Compte de publication requis");
  else {
    if (account.network !== network) issues.push(`Le compte « ${account.label} » publie sur ${account.network}, pas sur ${network}`);
    if (account.project !== p.project) issues.push("Le compte n'appartient pas au projet de la publication");
    if (account.status !== "connected") issues.push(`Compte ${account.status === "expired" ? "à reconnecter" : "indisponible"}`);
  }
  const text = String(p.text ?? "");
  if (!text.trim()) issues.push("Texte requis");
  if (limit && text.length > limit.text) issues.push(`Texte trop long pour ${network} : ${text.length} / ${limit.text} caractères`);
  if (limit?.needsTitle && !String(p.title ?? "").trim()) issues.push("Titre requis pour YouTube");
  if (limit?.needsVisibility && !String(p.visible ?? "").trim()) issues.push("Confidentialité à choisir pour TikTok");
  // Médias : nombre par réseau, formats et plafonds officiels les plus stricts (§16.2).
  const media = p.id ? mediaOf(String(p.id)) as { mime: string; size: number }[] : [];
  if (limit && media.length > limit.media) issues.push(`Trop de médias pour ${network} : ${media.length} / ${limit.media}`);
  const video = (m: string) => m.startsWith("video/");
  if (network === "instagram") {
    if (media.some((m) => m.mime.startsWith("image/") && m.mime !== "image/jpeg")) issues.push("Instagram : images JPEG uniquement");
    if (media.some((m) => m.mime.startsWith("image/") && m.size > 8 * 1024 * 1024)) issues.push("Instagram : image de plus de 8 Mo");
  }
  if (network === "x" && media.some((m) => m.mime.startsWith("image/") && m.size > 5 * 1024 * 1024)) issues.push("X : image de plus de 5 Mo");
  if (network === "youtube" && media.some((m) => !video(m.mime))) issues.push("YouTube : une vidéo est requise");
  if (network === "tiktok" && media.some((m) => !video(m.mime))) issues.push("TikTok : vidéo ou photos compatible requises");
  if (network === "youtube" && media.length === 0) issues.push("YouTube : une vidéo est requise");
  return issues;
}

export type PublishResult = { ok: true; url: string } | { ok: false; kind: "auth" | "format" | "quota" | "rate" | "network" | "refused" | "unknown"; message: string };

/** Fournisseur factice : aucun réseau joint, résultat déterministe pour les tests. */
export async function publishToNetwork(p: Row, account: Row): Promise<PublishResult> {
  if (account.status === "expired") return { ok: false, kind: "auth", message: "Compte à reconnecter" };
  const text = String(p.text ?? "");
  if (text.includes("[quota]")) return { ok: false, kind: "quota", message: "Quota du réseau atteint" };
  if (text.includes("[rate]")) return { ok: false, kind: "rate", message: "Limite de débit atteinte" };
  if (text.includes("[fail]")) return { ok: false, kind: "refused", message: "Publication refusée par le réseau" };
  // Clé d'idempotence : un plantage après l'envoi ne crée jamais de doublon.
  if (p.idempotency_key) {
    const seen = db.prepare("SELECT url FROM pub_idempotency WHERE key = ?").get(String(p.idempotency_key)) as { url: string } | undefined;
    if (seen) return { ok: true, url: seen.url };
  }
  const url = `https://sim.test/${encodeURIComponent(String(p.network))}/${p.id}`;
  if (p.idempotency_key) db.prepare("INSERT OR IGNORE INTO pub_idempotency (key, url, at) VALUES (?, ?, ?)").run(String(p.idempotency_key), url, Date.now());
  return { ok: true, url };
}

const attempt = (id: string, state: string, detail?: string, evidence?: string) =>
  db.prepare("INSERT INTO pub_attempts (publication_id, ts, state, detail, evidence_url) VALUES (?, ?, ?, ?, ?)")
    .run(id, Date.now(), state, detail?.slice(0, 500) ?? null, evidence ?? null);

const setState = (id: string, state: PubState, extra: Row = {}) => {
  const cols = ["state = ?", "updated_at = ?"], args: (string | number | null)[] = [state, Date.now()];
  for (const [k, v] of Object.entries(extra)) { cols.push(`${k} = ?`); args.push(v as string | number | null); }
  args.push(id);
  db.prepare(`UPDATE publications SET ${cols.join(", ")} WHERE id = ?`).run(...args);
};

/** Au redémarrage, une publication « en cours » n'est jamais relancée : elle passe en « À vérifier ». */
export function recoverInterrupted() {
  const n = db.prepare("UPDATE publications SET state = 'to_verify', updated_at = ? WHERE state = 'running'").run(Date.now()).changes;
  if (n) securityEvent("approval_refused", `${n} publication(s) interrompue(s) → à vérifier`);
}

async function runOne(p: Row, now: number): Promise<void> {
  if (now - Number(p.scheduled_at) > MAX_LATE_MS) {
    setState(p.id, "missed", { status: "idea" });
    attempt(p.id, "missed", "Retard de plus de 2 h : publication non envoyée");
    return;
  }
  const claimed = db.prepare("UPDATE publications SET state = 'running', updated_at = ? WHERE id = ? AND state = 'scheduled'").run(now, p.id);
  if (!claimed.changes) return;
  const account = db.prepare("SELECT * FROM pub_accounts WHERE id = ?").get(p.account_id) as Row | undefined;
  const issues = validatePublication(p, account);
  if (issues.length || !account) {
    // Un compte déconnecté demande une action de l'utilisateur ; le reste est un échec de format.
    const auth = !!account && account.status !== "connected";
    setState(p.id, auth ? "needs_action" : "failed", { status: "idea" });
    attempt(p.id, auth ? "needs_action" : "failed", `${auth ? "authentification" : "format"} : ${issues.join(" ; ")}`);
    return;
  }
  if (account.mode === "web") {
    const approvalId = String(p.approval_id ?? "");
    if (!approvalId) { setState(p.id, "failed", { status: "idea" }); attempt(p.id, "failed", "approbation absente"); return; }
    const r = await publishWithBrowser({
      publication: { ...p, scheduled_at: p.scheduled_at },
      account, approvalId, agentId: "administrateur",
      baseUrl: String(account.web_url ?? ""), fixturePort: Number(account.fixture_port) || 0,
    });
    if (r.state === "published") {
      setState(p.id, "published", { status: "published", url: r.proof ?? null, evidence_url: r.proof ?? null, published_at: Date.now() });
      attempt(p.id, "published", "publié (navigateur, preuve)", r.proof);
    } else if (r.state === "action_required") {
      setState(p.id, "needs_action", { status: "idea" });
      attempt(p.id, "needs_action", r.message ?? "action requise");
    } else if (r.state === "to_verify") {
      setState(p.id, "to_verify", { status: "idea" });
      attempt(p.id, "to_verify", r.message ?? "résultat incertain");
    } else {
      setState(p.id, "failed", { status: "idea" });
      attempt(p.id, "failed", `${r.kind ?? "échec"} : ${r.message ?? ""}`);
    }
    return;
  }
  const dayStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  const done = (db.prepare("SELECT COUNT(*) AS n FROM pub_attempts WHERE ts >= ? AND state = 'published' AND publication_id IN (SELECT id FROM publications WHERE account_id = ?)").get(dayStart, account.id) as Row).n as number;
  if (done >= Number(account.daily_cap)) {
    setState(p.id, "failed", { status: "idea" });
    attempt(p.id, "failed", `quota : plafond quotidien du compte atteint (${account.daily_cap})`);
    return;
  }
  try {
    const r = await publishToNetwork(p, account);
    if (r.ok) {
      setState(p.id, "published", { status: "published", url: r.url, evidence_url: r.url, published_at: Date.now() });
      attempt(p.id, "published", "publié (factice)", r.url);
    } else if (r.kind === "auth") {
      setState(p.id, "needs_action", { status: "idea" });
      attempt(p.id, "needs_action", `authentification : ${r.message}`);
    } else {
      setState(p.id, "failed", { status: "idea" });
      attempt(p.id, r.kind, `${r.kind} : ${r.message}`);
    }
  } catch (e) {
    // Après le geste final, ou en cas d'ambiguïté : jamais de nouvelle tentative aveugle.
    setState(p.id, "to_verify", { status: "idea" });
    attempt(p.id, "to_verify", `résultat incertain : ${(e as Error).message}`);
  }
}

/** Une exécution de la file. Une seule publication traitée à la fois, jamais deux pour le même compte. */
export async function runPublicationQueue(now = Date.now()): Promise<number> {
  const due = db.prepare("SELECT * FROM publications WHERE state = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= ? ORDER BY scheduled_at LIMIT 10").all(now) as Row[];
  let done = 0;
  for (const p of due) {
    const busy = db.prepare("SELECT 1 FROM publications WHERE account_id = ? AND state = 'running'").get(p.account_id);
    if (busy) continue;
    await runOne(p, now);
    done += 1;
  }
  return done;
}

export function getPublication(id: string) {
  return db.prepare("SELECT * FROM publications WHERE id = ?").get(id) as Row | undefined;
}
export const attemptsOf = (id: string) => db.prepare("SELECT ts, state, detail, evidence_url FROM pub_attempts WHERE publication_id = ? ORDER BY id DESC LIMIT 50").all(id);

/** Programme (ou publie maintenant) : validation immédiate, puis file. */
export async function queuePublication(id: string, o: { at?: number; now?: boolean; text?: string; account_id?: string | null; visible?: string | null }, when = Date.now()) {
  const p = getPublication(id);
  if (!p) throw new Error("Publication introuvable");
  if (!["draft", "failed", "missed", "needs_action", "scheduled", "cancelled"].includes(String(p.state ?? "draft"))) throw new Error("Cette publication ne peut plus être programmée");
  const account = db.prepare("SELECT * FROM pub_accounts WHERE id = ?").get(o.account_id ?? p.account_id) as Row | undefined;
  const next = { ...p, text: o.text ?? p.text, account_id: o.account_id ?? p.account_id, visible: o.visible ?? p.visible };
  const issues = validatePublication(next, account);
  if (issues.length) throw new Error(issues.join(" ; "));
  const at = o.now ? when : Number(o.at);
  if (!Number.isFinite(at) || at <= 0) throw new Error("Date de programmation invalide");
  // Même contenu, même compte, même date ⇒ même clé : un rejeu ne crée pas de doublon.
  const idem = createHash("sha256").update(`${id}|${next.account_id}|${next.text}|${at}`).digest("hex");
  db.prepare("UPDATE publications SET text = ?, account_id = ?, visible = ?, state = 'scheduled', scheduled_at = ?, status = 'scheduled', idempotency_key = ?, updated_at = ? WHERE id = ?")
    .run(next.text ?? null, next.account_id, next.visible ?? null, at, idem, when, id);
  attempt(id, "scheduled", `programmé pour ${new Date(at).toISOString()}`);
  // Transport navigateur : l'approbation est liée au contenu exact et consommée avant le clic final.
  if (account?.mode === "web") {
    const row = getPublication(id)!;
    const projectId = (db.prepare("SELECT id FROM projects WHERE id = ? OR crm_key = ?").get(String(row.project), String(row.project)) as { id: string } | undefined)?.id;
    if (!projectId) throw new Error("Projet de la publication introuvable");
    const approval = createApproval("administrateur", { action: "publication_publish", project_id: projectId, target_id: id, payload: publicationBinding(row) });
    // La confirmation de l'administrateur EST l'approbation (§16.1 point 4).
    decideApproval(approval.id, "approved");
    db.prepare("UPDATE publications SET approval_id = ? WHERE id = ?").run(approval.id, id);
  }
  if (o.now) await runPublicationQueue(when);
  return getPublication(id);
}

export function cancelPublication(id: string) {
  const p = getPublication(id);
  if (!p) throw new Error("Publication introuvable");
  if (!["draft", "scheduled", "failed", "needs_action", "missed"].includes(String(p.state ?? "draft"))) throw new Error("Publication déjà partie : annulation impossible");
  setState(id, "cancelled", { status: "idea" });
  attempt(id, "cancelled", "annulée par l'administrateur");
  return getPublication(id);
}

/** Nouvelle tentative : uniquement sur un échec explicite, jamais sur « à vérifier ». */
export async function retryPublication(id: string, when = Date.now()) {
  const p = getPublication(id);
  if (!p) throw new Error("Publication introuvable");
  if (!["failed", "needs_action", "missed"].includes(String(p.state ?? ""))) throw new Error("Seule une publication en échec peut être réessayée");
  db.prepare("UPDATE publications SET state = 'scheduled', scheduled_at = ?, updated_at = ? WHERE id = ?").run(when, when, id);
  attempt(id, "scheduled", "nouvelle tentative demandée");
  await runPublicationQueue(when);
  return getPublication(id);
}

export function registerPublishers(app: Hono) {
  const admin = (c: any) => isAdmin(c) ? null : c.json({ error: "Réservé à l'administrateur" }, 403);
  app.get("/api/pub-accounts", (c) => admin(c) ?? c.json(listAccounts(c.req.query("project") || undefined)));
  app.post("/api/pub-accounts", async (c) => {
    const denied = admin(c); if (denied) return denied;
    try { return c.json(createAccount(await c.req.json().catch(() => ({}))), 201); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });
  app.delete("/api/pub-accounts/:id", (c) => {
    const denied = admin(c); if (denied) return denied;
    return deleteAccount(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "Compte introuvable" }, 404);
  });
  app.get("/api/publications/:id/attempts", (c) => {
    const denied = admin(c); if (denied) return denied;
    return getPublication(c.req.param("id")) ? c.json(attemptsOf(c.req.param("id"))) : c.json({ error: "Publication introuvable" }, 404);
  });
  app.post("/api/publications/:id/queue", async (c) => {
    const denied = admin(c); if (denied) return denied;
    const b = await c.req.json().catch(() => ({}));
    try {
      const at = b.now ? undefined : Date.parse(String(b.at ?? ""));
      const p = await queuePublication(c.req.param("id"), { at, now: !!b.now, text: typeof b.text === "string" ? b.text : undefined, account_id: typeof b.account_id === "string" ? b.account_id : undefined, visible: typeof b.visible === "string" ? b.visible : undefined });
      return c.json(p);
    } catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });
  app.post("/api/publications/:id/cancel", (c) => {
    const denied = admin(c); if (denied) return denied;
    try { return c.json(cancelPublication(c.req.param("id"))); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });
  app.post("/api/publications/:id/retry", async (c) => {
    const denied = admin(c); if (denied) return denied;
    try { return c.json(await retryPublication(c.req.param("id"))); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });

  // Tâche d'une minute : la file part sans intervention, une publication à la fois.
  registerJob("publications", { id: "publications-queue", every: "1m", run: async () => { await runPublicationQueue(); } });
  recoverInterrupted();
}

/** Utilisé par les tests pour vérifier l'état d'une publication sans passer par HTTP. */
export const publicationStates = () => db.prepare("SELECT id, state, scheduled_at, status FROM publications").all();
export const nowString = nowIso;
