// SEC-01 : budgets persistants, budgets séparés, fenêtre, journal SEC-08.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db.ts";
import { blocked, fail, resetIp, WINDOW_MS } from "./security-limits.ts";
import { recentSecurityEvents } from "./security-events.ts";

const clean = () => { db.exec("DELETE FROM rate_limits"); db.exec("DELETE FROM security_events"); };

test("SEC-01 : 5 échecs par IP puis blocage, remise à zéro de l'IP seule, expiration de la fenêtre", () => {
  clean();
  const now = 1_000_000;
  for (let i = 0; i < 5; i++) fail("login", "10.0.0.1", now);
  assert.equal(blocked("login", "10.0.0.1", now), true);
  resetIp("login", "10.0.0.1");
  assert.equal(blocked("login", "10.0.0.1", now), false);
  for (let i = 0; i < 5; i++) fail("login", "10.0.0.2", now);
  assert.equal(blocked("login", "10.0.0.2", now + WINDOW_MS - 1), true);
  assert.equal(blocked("login", "10.0.0.2", now + WINDOW_MS), false, "expiré après 15 min");
});

test("SEC-01 : budget global 15/15 min toutes IP, et canal 2FA séparé", () => {
  clean();
  const now = 2_000_000;
  for (let i = 0; i < 15; i++) fail("login", `10.0.1.${i}`, now);
  assert.equal(blocked("login", "10.0.2.1", now), true, "global login atteint");
  assert.equal(blocked("twofa", "10.0.2.1", now), false, "le budget 2FA est séparé");
  db.exec("DELETE FROM rate_limits");
  for (let i = 0; i < 5; i++) fail("twofa", "10.0.3.1", now);
  assert.equal(blocked("twofa", "10.0.3.1", now), true, "IP 2FA bloquée");
  assert.equal(blocked("login", "10.0.3.1", now), false, "login non bloqué par la 2FA");
});

test("SEC-08 : verrouillage et rafale journalisés sans IP ni secret", () => {
  clean();
  for (let i = 0; i < 5; i++) fail("login", "192.0.2.55", 3_000_000);
  const events = recentSecurityEvents(50) as { kind: string; detail: string }[];
  assert.ok(events.some((e) => e.kind === "login_lockout"), "verrouillage écrit");
  assert.ok(events.every((e) => !e.detail.includes("192.0.2.55")), "aucune IP dans detail");
});
