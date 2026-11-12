#!/usr/bin/env node
// Vérifie une sauvegarde à blanc : déchiffre (v2) ou lit v1, integrity_check, comptages,
// déchiffrement d'une connexion avec le SECRET restauré. Ne touche jamais la base active.
// Usage : npm run backup:verify <fichier>   (BACKUP_PASSPHRASE requis pour un lot v2)
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [file, active] = process.argv.slice(2);
if (!file) { console.error("Usage : npm run backup:verify <fichier.bundle[.v2]>"); process.exit(2); }
const activeHash = active && existsSync(active) ? createHash("sha256").update(readFileSync(active)).digest("hex") : null;
const dir = mkdtempSync(join(tmpdir(), "st-verify-"));
try {
  const { decodeAnyBundle } = await import("../server/backup-crypto.ts");
  const { payload, legacy } = decodeAnyBundle(readFileSync(file), process.env.BACKUP_PASSPHRASE ?? null);
  writeFileSync(join(dir, "searchtide.db"), payload.db, { mode: 0o600 });
  if (payload.secret) writeFileSync(join(dir, "secret"), payload.secret.trim() + "\n", { mode: 0o600 });
  if (payload.adminPassword) writeFileSync(join(dir, "admin-password"), payload.adminPassword.trim() + "\n", { mode: 0o600 });
  process.env.DATABASE_PATH = join(dir, "searchtide.db");
  process.env.SECRET = payload.secret?.trim() ?? "";
  const { db } = await import("../server/db.ts");
  const integrity = (db.prepare("PRAGMA integrity_check").get()).integrity_check;
  const tables = (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get()).n;
  const rows = (db.prepare("SELECT COUNT(*) AS n FROM events").get()).n;
  let connection = "aucune";
  if (payload.secret) {
    const { connections, getSecrets } = await import("../server/connections.ts");
    const c = connections()[0];
    if (c) { getSecrets(c.id); connection = "déchiffrée"; }
  }
  const afterHash = active && existsSync(active) ? createHash("sha256").update(readFileSync(active)).digest("hex") : null;
  console.log(JSON.stringify({ ok: integrity === "ok" && (activeHash === null || activeHash === afterHash), integrity, tables, events: rows, connection, legacy, activeUnchanged: activeHash === null || activeHash === afterHash }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: e.message }));
  process.exitCode = 1;
} finally { rmSync(dir, { recursive: true, force: true }); }
