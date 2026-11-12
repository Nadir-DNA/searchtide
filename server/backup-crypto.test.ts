// P1-B : lot v2 chiffré (AES-256-GCM + scrypt), mauvaises phrases, altération, vérification à blanc, refus sans phrase.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { decodeAnyBundle, encryptBundle } from "./backup-crypto.ts";
import { bundlePayload, makeBundle } from "./backup-bundle.ts";
import { offsiteBackup } from "./ops.ts";

const payload = (db: Buffer) => ({ version: 2, day: "2026-11-11", db: db.toString("base64"), secret: Buffer.from("s".repeat(40)).toString("base64"), adminPassword: Buffer.from("motdepasse").toString("base64") });

test("P1-B : v2 chiffre, aucune chaîne SECRET en clair, mauvaise phrase et octet altéré refusés", () => {
  const db = Buffer.from("SQLite format 3\0base factice");
  const buf = encryptBundle(payload(db), "phrase-de-sauvegarde");
  assert.doesNotMatch(buf.toString("utf8"), /s{40}|motdepasse/, "aucun secret en clair");
  assert.deepEqual(decodeAnyBundle(buf, "phrase-de-sauvegarde").payload.db, db);
  assert.throws(() => decodeAnyBundle(buf, "mauvaise-phrase-longue"), /incorrecte|altérée/);
  assert.throws(() => encryptBundle(payload(db), "court"), /16 caractères/);
  const tampered = Buffer.from(buf);
  tampered[Math.floor(tampered.length / 2)] ^= 1;
  assert.throws(() => decodeAnyBundle(tampered, "phrase-de-sauvegarde"), /altérée|incorrecte/);
});

test("P1-B : ancien lot v1 toujours lisible ; vérification à blanc sur v1 et v2, base active inchangée", () => {
  const t = mkdtempSync(join(tmpdir(), "st-v2-"));
  try {
    const dbFile = join(t, "empty.db");
    const empty = new DatabaseSync(dbFile); empty.exec("CREATE TABLE temoin (x INTEGER)"); empty.close();
    const v1 = makeBundle(dbFile, join(t, "absent"), join(t, "absent"), "2026-11-11");
    const v1File = join(t, "v1.bundle.json.gz"); writeFileSync(v1File, v1);
    assert.equal(decodeAnyBundle(v1).legacy, true);
    const active = join(t, "active.db"); writeFileSync(active, "actif");
    const before = readFileSync(active);
    const out = execFileSync(process.execPath, ["scripts/backup-verify.mjs", v1File, active], { encoding: "utf8", env: { ...process.env, BACKUP_PASSPHRASE: "" } });
    const r = JSON.parse(out.trim().split("\n").at(-1) ?? "{}");
    assert.equal(r.ok, true, out);
    assert.equal(r.legacy, true);
    assert.equal(r.activeUnchanged, true);
    assert.deepEqual(readFileSync(active), before, "base active intacte");

    const v2 = encryptBundle(bundlePayload(dbFile, join(t, "absent"), join(t, "absent"), "2026-11-11") as any, "phrase-test-123456");
    const v2File = join(t, "v2.bundle"); writeFileSync(v2File, v2);
    const out2 = execFileSync(process.execPath, ["scripts/backup-verify.mjs", v2File, active], { encoding: "utf8", env: { ...process.env, BACKUP_PASSPHRASE: "phrase-test-123456" } });
    assert.equal(JSON.parse(out2.trim().split("\n").at(-1) ?? "{}").ok, true);
    // La restauration documentée accepte le v2 ; sans phrase, message clair.
    const restored = join(t, "restored-v2");
    execFileSync(process.execPath, ["scripts/restore-backup.mjs", v2File, restored], { encoding: "utf8", env: { ...process.env, BACKUP_PASSPHRASE: "phrase-test-123456" } });
    assert.ok(readFileSync(join(restored, "searchtide.db")).length > 0);
    assert.throws(() => execFileSync(process.execPath, ["scripts/restore-backup.mjs", v2File, join(t, "restored-sans")], { encoding: "utf8", env: { ...process.env, BACKUP_PASSPHRASE: "" }, stdio: "pipe" }), /Phrase de passe requise|restauration impossible/i);
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test("P1-B : copie externe refusée sans phrase de passe", async () => {
  const old = { url: process.env.BACKUP_URL, token: process.env.BACKUP_TOKEN, pass: process.env.BACKUP_PASSPHRASE };
  process.env.BACKUP_URL = "https://backup.test"; process.env.BACKUP_TOKEN = "jeton"; delete process.env.BACKUP_PASSPHRASE;
  try { await assert.rejects(offsiteBackup(), /phrase de passe|PASSPHRASE/i); }
  finally {
    if (old.url === undefined) delete process.env.BACKUP_URL; else process.env.BACKUP_URL = old.url;
    if (old.token === undefined) delete process.env.BACKUP_TOKEN; else process.env.BACKUP_TOKEN = old.token;
    if (old.pass === undefined) delete process.env.BACKUP_PASSPHRASE; else process.env.BACKUP_PASSPHRASE = old.pass;
  }
});
