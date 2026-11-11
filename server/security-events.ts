// SEC-08 : journal des événements de sécurité, sans IP ni secret.
import { db } from "./db.ts";

db.exec("CREATE TABLE IF NOT EXISTS security_events (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT)");

export const SECURITY_KINDS = ["login_lockout", "login_fail_burst", "twofa_enabled", "twofa_disabled", "purge", "key_created", "key_revoked", "backup_passphrase_changed", "scope_changed", "approval_created", "approval_approved", "approval_rejected", "approval_expired", "approval_consumed", "approval_refused", "legacy_secret_config"] as const;
export type SecurityKind = typeof SECURITY_KINDS[number];

export function securityEvent(kind: SecurityKind, detail = "") {
  db.prepare("INSERT INTO security_events (ts, kind, detail) VALUES (?, ?, ?)").run(Date.now(), kind, detail.slice(0, 200));
}

export function recentSecurityEvents(limit = 50) {
  return db.prepare("SELECT ts, kind, detail FROM security_events ORDER BY id DESC LIMIT ?").all(Math.min(Math.max(limit, 1), 200));
}
