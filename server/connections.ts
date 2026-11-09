// Connexions aux services : stockage des comptes branchés par l'utilisateur.
// Les secrets (clés, jetons, mots de passe) ne sont écrits que chiffrés, dans `secrets` (voir vault.ts).
// Le reste (libellé, indice non secret, réglages) est dans `config`. Aucune route ne renvoie un secret.
import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import { db } from "./db.ts";
import { migrate } from "./migrations.ts";
import { RECONNECT_MESSAGE, VaultError, fingerprint, open, scrub, seal, secretValid, secretValues } from "./vault.ts";

db.exec(`
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,              -- identifiant du connecteur : stripe, google, smtp…
  label TEXT NOT NULL,             -- nom affiché, modifiable
  account TEXT NOT NULL DEFAULT '',-- identifiant du compte chez le fournisseur, si connu
  scope TEXT,
  livemode INTEGER NOT NULL DEFAULT 0,
  access_token TEXT,               -- ANCIEN stockage en clair : vidé par la migration vers secrets
  refresh_token TEXT,              -- idem
  created_at INTEGER NOT NULL
);
`);

migrate("2026-11-09-coffre-connexions", `
ALTER TABLE connections ADD COLUMN config TEXT NOT NULL DEFAULT '{}';
ALTER TABLE connections ADD COLUMN secrets TEXT;
ALTER TABLE connections ADD COLUMN fingerprint TEXT;
ALTER TABLE connections ADD COLUMN status TEXT NOT NULL DEFAULT 'connected';
ALTER TABLE connections ADD COLUMN status_detail TEXT;
ALTER TABLE connections ADD COLUMN tested_at INTEGER;
CREATE INDEX connections_kind ON connections(kind);
`);
// config : réglages non secrets + indice (hint) · secrets : bloc chiffré AES-256-GCM · fingerprint : HMAC du secret principal (doublons)
// status : connected | error | reconnect

type Row = Record<string, any>;
export type Status = "connected" | "error" | "reconnect";

const PUBLIC_COLS = "id, kind, label, account, scope, livemode, config, status, status_detail, tested_at, created_at";
const decode = (r: Row): Row => ({ ...r, config: JSON.parse(r.config ?? "{}") });

/** Liste des connexions SANS secret (id, type, libellé, indice, statut). */
export function connections(kind?: string): Row[] {
  const rows = (kind
    ? db.prepare(`SELECT ${PUBLIC_COLS} FROM connections WHERE kind = ? ORDER BY created_at`).all(kind)
    : db.prepare(`SELECT ${PUBLIC_COLS} FROM connections ORDER BY created_at`).all()) as Row[];
  return rows.map(decode);
}

export function getConnection(id: string): Row | undefined {
  const r = db.prepare(`SELECT ${PUBLIC_COLS} FROM connections WHERE id = ?`).get(id) as Row | undefined;
  return r && decode(r);
}

const idOf = (c: string | Row) => (typeof c === "string" ? c : c.id) as string;

/** Seul accès en lecture aux secrets d'une connexion. Lève `VaultError` si SECRET est invalide ou a changé. */
export function getSecrets(conn: string | Row): Record<string, any> {
  const r = db.prepare("SELECT secrets FROM connections WHERE id = ?").get(idOf(conn)) as Row | undefined;
  if (!r) throw new Error("Connexion introuvable");
  try { return open(r.secrets); }
  catch (e) { if (e instanceof VaultError && e.code === "undecryptable") markStatus(idOf(conn), "reconnect", RECONNECT_MESSAGE); throw e; }
}

/** Seul accès en écriture aux secrets. Refuse si SECRET est absent, `dev-secret` ou trop court (R2). */
export function setSecrets(conn: string | Row, obj: Record<string, unknown>, fp?: string | null) {
  const blob = seal(obj); // lève secret-invalid
  db.prepare("UPDATE connections SET secrets = ?, fingerprint = COALESCE(?, fingerprint) WHERE id = ?").run(blob, fp ?? null, idOf(conn));
}

export function markStatus(id: string, status: Status, detail: string | null = null) {
  db.prepare("UPDATE connections SET status = ?, status_detail = ?, tested_at = ? WHERE id = ?").run(status, detail, Date.now(), id);
}

export type NewConnection = {
  kind: string; label: string; config?: Record<string, unknown>; secrets?: Record<string, unknown>;
  account?: string; livemode?: boolean; scope?: string | null;
  /** Valeur du secret principal, pour l'empreinte anti-doublon. */
  fingerprintOf?: string;
};

/** Crée une connexion. Les secrets sont chiffrés avant toute écriture ; sans SECRET valable, rien n'est écrit. */
export function createConnection(n: NewConnection): Row {
  const blob = n.secrets ? seal(n.secrets) : null; // lève secret-invalid avant l'INSERT
  const fp = n.fingerprintOf ? fingerprint(n.kind, n.fingerprintOf) : null;
  const id = randomBytes(8).toString("hex");
  db.prepare(`INSERT INTO connections (id, kind, label, account, scope, livemode, config, secrets, fingerprint, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'connected', ?)`)
    .run(id, n.kind, n.label, n.account ?? "", n.scope ?? null, n.livemode ? 1 : 0, JSON.stringify(n.config ?? {}), blob, fp, Date.now());
  return getConnection(id)!;
}

export function findByFingerprint(kind: string, value: string): Row | undefined {
  const r = db.prepare(`SELECT ${PUBLIC_COLS} FROM connections WHERE kind = ? AND fingerprint = ?`).get(kind, fingerprint(kind, value)) as Row | undefined;
  return r && decode(r);
}

export function removeConnection(id: string) {
  return db.prepare("DELETE FROM connections WHERE id = ?").run(id).changes > 0;
}

/**
 * Migration (D5) : tout jeton resté en clair dans `access_token` / `refresh_token` est chiffré dans `secrets`,
 * puis les colonnes sont vidées. Idempotente : sans jeton en clair, elle ne fait rien. Sans SECRET valable,
 * elle laisse les jetons en place et le signale (nouvel essai au prochain démarrage).
 */
export function migrateClearTokens(): { migrated: number; pending: number } {
  const rows = db.prepare("SELECT id, access_token, refresh_token, secrets FROM connections WHERE (access_token IS NOT NULL AND access_token != '') OR (refresh_token IS NOT NULL AND refresh_token != '')").all() as Row[];
  if (!rows.length) return { migrated: 0, pending: 0 };
  if (!secretValid()) return { migrated: 0, pending: rows.length };
  let migrated = 0;
  for (const r of rows) {
    let current: Record<string, any> = {};
    try { current = open(r.secrets); } catch { /* secrets illisibles : on repart des jetons en clair */ }
    const next = { ...current, ...(r.access_token ? { access_token: r.access_token } : {}), ...(r.refresh_token ? { refresh_token: r.refresh_token } : {}) };
    db.exec("BEGIN");
    try {
      db.prepare("UPDATE connections SET secrets = ?, access_token = NULL, refresh_token = NULL WHERE id = ?").run(seal(next), r.id);
      db.exec("COMMIT"); migrated++;
    } catch (e) { db.exec("ROLLBACK"); throw e; }
  }
  return { migrated, pending: 0 };
}

/** Au démarrage : migre les jetons en clair, ou avertit s'il n'y a pas de SECRET valable. */
export function startVault() {
  const r = migrateClearTokens();
  if (r.pending) console.warn(`[coffre] ${r.pending} connexion(s) gardent un jeton en clair : définissez SECRET (32 caractères ou plus) puis redémarrez.`);
  else if (r.migrated) console.log(`[coffre] ${r.migrated} jeton(s) chiffré(s)`);
  return r;
}

export { scrub, secretValues };

export function registerConnections(app: Hono) {
  app.get("/api/connections", (c) => c.json({ vault: secretValid(), list: connections() }));
  app.delete("/api/connections/:id", (c) => removeConnection(c.req.param("id"))
    ? c.json({ ok: true })
    : c.json({ error: "Connexion introuvable" }, 404));
}
