import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, base32Decode, base32Encode, loginLimiter, totp, verifyTotp } from "./security.ts";

test("TOTP : vecteur de la RFC 6238 et tolérance de 30 s", () => {
  const secret = base32Encode(Buffer.from("12345678901234567890"));
  assert.equal(totp(secret, 59_000), "287082");
  assert.equal(totp(secret, 1111111109_000), "081804");
  assert.ok(verifyTotp(secret, "081804", 1111111109_000 + 30_000));
  assert.ok(!verifyTotp(secret, "081804", 1111111109_000 + 90_000));
  assert.ok(!verifyTotp(secret, "abc"));
  assert.deepEqual(base32Decode(secret), Buffer.from("12345678901234567890"));
});

test("limite des essais de connexion", () => {
  const l = loginLimiter(3, 1000);
  for (let i = 0; i < 3; i++) l.fail("1.2.3.4", 0);
  assert.ok(l.blocked("1.2.3.4", 10));
  assert.ok(!l.blocked("5.6.7.8", 10));
  assert.ok(!l.blocked("1.2.3.4", 2000), "débloqué après la fenêtre");
});

test("sauvegarde cohérente de la base", () => {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/searchtide-test-${process.pid}`;
  const f = backup(dir, 2, new Date("2026-11-09T02:00:00Z"));
  assert.ok(existsSync(f));
});

test("R3 : la sauvegarde inclut SECRET et le mot de passe généré, sans quoi le coffre serait indéchiffrable", () => {
  const dir = mkdtempSync(join(tmpdir(), "st-bk-")); const data = mkdtempSync(join(tmpdir(), "st-data-"));
  const previous = process.env.DATABASE_PATH;
  try {
    writeFileSync(join(data, "secret"), "s".repeat(64) + "\n", { mode: 0o600 });
    writeFileSync(join(data, "admin-password"), "motdepasse-genere\n", { mode: 0o600 });
    process.env.DATABASE_PATH = join(data, "searchtide.db");
    const f = backup(dir, 14, new Date("2026-11-09T02:00:00Z"));
    assert.ok(existsSync(f));
    const secret = join(dir, "searchtide-2026-11-09.secret"), pw = join(dir, "searchtide-2026-11-09.admin-password");
    assert.equal(readFileSync(secret, "utf8").trim().length, 64);
    assert.equal(readFileSync(pw, "utf8").trim(), "motdepasse-genere");
    assert.equal(statSync(secret).mode & 0o777, 0o600, "même protection que l'original");
    assert.equal(statSync(pw).mode & 0o777, 0o600);
  } finally {
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    rmSync(dir, { recursive: true, force: true }); rmSync(data, { recursive: true, force: true });
  }
});
