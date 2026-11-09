import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
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
