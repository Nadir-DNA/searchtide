// Sauvegarde complète (S2) : un seul fichier gzippé contenant la base et les fichiers de démarrage
// (SECRET, admin-password), pour qu'une restauration hors site garde le coffre déchiffrable.
// Aucune valeur n'est journalisée. Ne pas confondre avec `backup()` (copie locale de la base seule).
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

export type DecodedBundle = { day: string | null; db: Buffer; secret: string | null; adminPassword: string | null };

/** Construit le bundle à partir de la base et des fichiers de démarrage (les absents restent null). */
export function makeBundle(dbFile: string, secretFile: string, passwordFile: string, day: string): Buffer {
  const text = (f: string) => (existsSync(f) ? readFileSync(f).toString("base64") : null);
  const payload = { version: 1, day, db: readFileSync(dbFile).toString("base64"), secret: text(secretFile), adminPassword: text(passwordFile) };
  return gzipSync(Buffer.from(JSON.stringify(payload)));
}

export function decodeBundle(buf: Buffer): DecodedBundle {
  const b = JSON.parse(gunzipSync(buf).toString()) as { day?: string; db?: string; secret?: string | null; adminPassword?: string | null };
  if (!b.db) throw new Error("Sauvegarde incomplète : base absente du bundle");
  return {
    day: b.day ?? null,
    db: Buffer.from(b.db, "base64"),
    secret: b.secret ? Buffer.from(b.secret, "base64").toString() : null,
    adminPassword: b.adminPassword ? Buffer.from(b.adminPassword, "base64").toString() : null,
  };
}

/** Écrit la base et les fichiers de démarrage dans un dossier, en 600 ; signale un SECRET manquant. */
export function writeBundle(dataDir: string, b: DecodedBundle): { files: string[]; secretMissing: boolean } {
  mkdirSync(dataDir, { recursive: true });
  const files: string[] = [];
  const put = (name: string, content: Buffer | string) => {
    const f = join(dataDir, name);
    writeFileSync(f, content, { mode: 0o600 });
    chmodSync(f, 0o600);
    files.push(f);
  };
  put("searchtide.db", b.db);
  if (b.secret) put("secret", b.secret.trim() + "\n");
  if (b.adminPassword) put("admin-password", b.adminPassword.trim() + "\n");
  return { files, secretMissing: !b.secret };
}
