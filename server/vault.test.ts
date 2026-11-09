// Tests du coffre (T6) : chiffrement, refus sans SECRET valable, migration des jetons en clair, absence du secret dans le fichier SQLite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { db } from "./db.ts";
import { createConnection, getSecrets, setSecrets, migrateClearTokens, connections, findByFingerprint } from "./connections.ts";
import { registerConnections } from "./connectors/api.ts";
import { VaultError, seal, open, scrub, secretValid, SECRET_MESSAGE } from "./vault.ts";

const GOOD = "s".repeat(40);
const withSecret = <T>(v: string | undefined, fn: () => T): T => {
  const old = process.env.SECRET;
  if (v === undefined) delete process.env.SECRET; else process.env.SECRET = v;
  try { return fn(); } finally { if (old === undefined) delete process.env.SECRET; else process.env.SECRET = old; }
};

test("SECRET valable : 32 caractères ou plus, ni absent ni dev-secret", () => {
  assert.equal(secretValid(undefined as any), false);
  assert.equal(secretValid("dev-secret"), false);
  assert.equal(secretValid("x".repeat(31)), false);
  assert.equal(secretValid("x".repeat(32)), true);
});

test("seal/open : aller-retour, nonce différent à chaque fois, altération refusée", () => withSecret(GOOD, () => {
  const a = seal({ key: "rk_test_abcdef" }), b = seal({ key: "rk_test_abcdef" });
  assert.notEqual(a, b, "un nonce neuf à chaque chiffrement");
  assert.deepEqual(open(a), { key: "rk_test_abcdef" });
  assert.throws(() => open(a.slice(0, -3) + "AAA"), (e: any) => e instanceof VaultError && e.code === "undecryptable");
  assert.deepEqual(open(null), {});
}));

test("CA8 : sans SECRET valable, rien n'est chiffré ni enregistré", () => {
  const before = (db.prepare("SELECT COUNT(*) AS n FROM connections").get() as any).n;
  for (const bad of [undefined, "dev-secret", "court"]) withSecret(bad, () => {
    assert.throws(() => createConnection({ kind: "stripe", label: "x", secrets: { key: "rk_test_zzz" } }), (e: any) => e instanceof VaultError && e.code === "secret-invalid" && e.message === SECRET_MESSAGE);
  });
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM connections").get() as any).n, before);
});

test("créer, relire et mettre à jour les secrets ; la liste n'en contient aucun", () => withSecret(GOOD, () => {
  const c = createConnection({ kind: "stripe", label: "Test", config: { hint: "rk_test_…wxyz" }, secrets: { key: "rk_" + "test_PRIVATE0123wxyz" }, fingerprintOf: "rk_" + "test_PRIVATE0123wxyz" });
  assert.deepEqual(getSecrets(c), { key: "rk_" + "test_PRIVATE0123wxyz" });
  assert.equal(findByFingerprint("stripe", "rk_" + "test_PRIVATE0123wxyz")?.id, c.id);
  assert.equal(findByFingerprint("google", "rk_" + "test_PRIVATE0123wxyz"), undefined, "empreinte propre au connecteur");
  setSecrets(c, { key: "rk_" + "test_AUTRE9876" });
  assert.equal(getSecrets(c.id).key, "rk_" + "test_AUTRE9876");
  const dump = JSON.stringify(connections());
  assert.doesNotMatch(dump, /PRIVATE0123|AUTRE9876|secrets|access_token|refresh_token/);
}));

test("CA10 : la migration chiffre les jetons en clair, vide les colonnes et reste idempotente", () => withSecret(GOOD, () => {
  db.prepare("INSERT INTO connections (id, kind, label, account, access_token, refresh_token, created_at) VALUES ('legacy1', 'stripe', 'Ancien', 'acct_1', 'sk_clair_ACCESS123', 'rt_clair_REFRESH456', 1)").run();
  const first = migrateClearTokens();
  assert.equal(first.migrated >= 1, true);
  const row = db.prepare("SELECT access_token, refresh_token, secrets FROM connections WHERE id = 'legacy1'").get() as any;
  assert.equal(row.access_token, null);
  assert.equal(row.refresh_token, null);
  assert.doesNotMatch(row.secrets, /ACCESS123|REFRESH456/);
  assert.deepEqual(getSecrets("legacy1"), { access_token: "sk_clair_ACCESS123", refresh_token: "rt_clair_REFRESH456" });
  const blob = row.secrets;
  assert.deepEqual(migrateClearTokens(), { migrated: 0, pending: 0 });
  assert.equal((db.prepare("SELECT secrets FROM connections WHERE id = 'legacy1'").get() as any).secrets, blob, "second passage : rien ne change");
}));

test("CA10 : sans SECRET valable, la migration laisse les jetons et le dit", () => {
  db.prepare("INSERT INTO connections (id, kind, label, account, access_token, created_at) VALUES ('legacy2', 'stripe', 'Ancien 2', 'acct_2', 'sk_clair_PENDING789', 1)").run();
  withSecret("dev-secret", () => assert.deepEqual(migrateClearTokens(), { migrated: 0, pending: 1 }));
  assert.equal((db.prepare("SELECT access_token FROM connections WHERE id = 'legacy2'").get() as any).access_token, "sk_clair_PENDING789");
  withSecret(GOOD, () => { migrateClearTokens(); });
  assert.equal((db.prepare("SELECT access_token FROM connections WHERE id = 'legacy2'").get() as any).access_token, null);
});

test("GET /api/connections : indique l'état du coffre, jamais de secret", async () => {
  const app = new Hono(); registerConnections(app);
  withSecret(GOOD, () => createConnection({ kind: "ntfy", label: "ntfy", secrets: { topic: "SUJET-TRES-SECRET-123" } }));
  const body = await (await app.request("/api/connections")).text();
  assert.doesNotMatch(body, /SUJET-TRES-SECRET|secrets|access_token/);
  assert.equal(JSON.parse(body).vault, secretValid());
});

test("scrub : remplace chaque occurrence d'un secret par •••", () => {
  assert.equal(scrub("Erreur avec la clé rk_" + "live_ABCD1234 et rk_" + "live_ABCD1234", ["rk_" + "live_ABCD1234"]), "Erreur avec la clé ••• et •••");
  assert.equal(scrub("abc", ["ab"]), "abc", "valeur trop courte ignorée");
});

test("CA5 : le secret n'apparaît pas en clair dans le fichier SQLite (ni dans le journal WAL)", () => {
  const dir = mkdtempSync(join(tmpdir(), "st-vault-"));
  try {
    const marker = "rk_" + "live_CA5MARKER" + "Z9y8x7w6v5u4t3s2";
    const script = `
      import { createConnection, getSecrets } from ${JSON.stringify(new URL("./connections.ts", import.meta.url).href)};
      import { db } from ${JSON.stringify(new URL("./db.ts", import.meta.url).href)};
      const c = createConnection({ kind: "stripe", label: "CA5", secrets: { key: process.env.MARKER }, fingerprintOf: process.env.MARKER });
      if (getSecrets(c).key !== process.env.MARKER) throw new Error("relecture");
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    `;
    execFileSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, DATABASE_PATH: join(dir, "t.db"), SECRET: GOOD, MARKER: marker }, stdio: "pipe" });
    const files = readdirSync(dir);
    assert.ok(files.includes("t.db"));
    for (const f of files) {
      const bytes = readFileSync(join(dir, f));
      assert.equal(bytes.includes(marker), false, `${f} contient le secret`);
      assert.equal(bytes.includes(marker.slice(10, 30)), false, `${f} contient un morceau du secret`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
