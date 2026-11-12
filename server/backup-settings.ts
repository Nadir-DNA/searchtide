// P1-B : phrase de passe de sauvegarde (BACKUP_PASSPHRASE ou réglage chiffré).
import { db } from "./db.ts";
import { open, seal } from "./vault.ts";

db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)");

export function backupPassphrase(): string | null {
  const env = process.env.BACKUP_PASSPHRASE?.trim();
  if (env) return env;
  const row = db.prepare("SELECT value FROM settings WHERE key = 'backup_passphrase'").get() as { value: string } | undefined;
  if (!row?.value) return null;
  try { return String(open(row.value).passphrase ?? "") || null; } catch { return null; }
}

export function setBackupPassphrase(pass: string | null) {
  if (pass && pass.length < 16) throw new Error("Phrase de passe : 16 caractères minimum");
  if (!pass) { db.prepare("DELETE FROM settings WHERE key = 'backup_passphrase'").run(); return; }
  db.prepare("INSERT INTO settings (key, value) VALUES ('backup_passphrase', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(seal({ passphrase: pass }));
}
