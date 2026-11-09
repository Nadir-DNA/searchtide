// S2 : sauvegarde complète (base + SECRET + admin-password) et restauration qui garde le coffre déchiffrable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeBundle } from "./backup-bundle.ts";

const root = new URL("./", import.meta.url).href;
const KEY = "rk_" + "test_RESTAURATION0123456789";
const SECRET = "r".repeat(64);

const run = (program: string, env: Record<string, string>) =>
  execFileSync(process.execPath, ["--input-type=module", "-e", program.replaceAll("@server/", root)], { env: { ...process.env, ...env }, encoding: "utf8", stdio: "pipe" });

test("S2 : la sauvegarde complète restaurée garde une connexion déchiffrable", () => {
  const t = mkdtempSync(join(tmpdir(), "st-restore-"));
  const data = join(t, "data"), backups = join(t, "backups"), restored = join(t, "restored");
  try {
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "secret"), SECRET + "\n", { mode: 0o600 });   // simule le fichier de démarrage
    const created = run(`import { createConnection } from "@server/connections.ts";
      const c = createConnection({ kind: "stripe", label: "Sauvegarde", config: { hint: "…" }, secrets: { key: "${KEY}" } });
      console.log(c.id);`, { DATABASE_PATH: join(data, "searchtide.db"), SECRET, BACKUP_DIR: backups });
    const id = created.trim();
    // La sauvegarde complète est faite avec le même dossier de données (fichier secret présent).
    const bundle = run(`import { backupBundle } from "@server/security.ts";
      process.env.DATABASE_PATH = ${JSON.stringify(join(data, "searchtide.db"))};
      console.log(backupBundle(${JSON.stringify(backups)}, 14, new Date("2026-11-09T02:00:00Z")));`,
      { DATABASE_PATH: join(data, "searchtide.db"), SECRET });
    const file = bundle.trim();
    assert.ok(existsSync(file), file);
    assert.equal(statSync(file).mode & 0o777, 0o600, "bundle protégé");
    // Restauration par le script livré.
    execFileSync(process.execPath, ["scripts/restore-backup.mjs", file, restored], { encoding: "utf8", stdio: "pipe" });
    assert.equal(statSync(join(restored, "secret")).mode & 0o777, 0o600);
    // Nouveau processus : la base restaurée + le SECRET restauré ouvrent le coffre.
    const secret = run(`import { getSecrets } from "@server/connections.ts";
      console.log(getSecrets(${JSON.stringify(id)}).key);`, {
      DATABASE_PATH: join(restored, "searchtide.db"),
      SECRET: readFileSync(join(restored, "secret"), "utf8").trim(),
    });
    assert.equal(secret.trim(), KEY, "la clé de connexion se déchiffre après restauration");
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test("S2 : une sauvegarde sans SECRET est signalée et ne prétend pas restaurer le coffre", () => {
  const dir = mkdtempSync(join(tmpdir(), "st-nosecret-"));
  try {
    const r = writeBundle(dir, { day: "2026-11-09", db: Buffer.from("sqlite"), secret: null, adminPassword: null });
    assert.equal(r.secretMissing, true);
    assert.ok(existsSync(join(dir, "searchtide.db")));
    assert.ok(!existsSync(join(dir, "secret")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
