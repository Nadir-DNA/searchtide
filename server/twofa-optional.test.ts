// §14.4 : la 2FA est facultative, désactivée par défaut ; l'avertissement de démarrage en tient compte.
import { test } from "node:test";
import assert from "node:assert/strict";
import { login, seed, startServer, tempDb } from "./test-server.ts";
import { missing2faWarning } from "./twofa-warning.ts";

test("2FA facultative : instance neuve → désactivée, connexion par mot de passe seul", async () => {
  const t = tempDb();
  const s = await startServer(t.path);
  try {
    const cfg = await (await fetch(`${s.base}/api/auth-config`)).json();
    assert.equal(cfg.totp, false, "désactivée par défaut");
    assert.equal((await (await fetch(`${s.base}/api/2fa`, { headers: { Cookie: await login(s.base) } })).json()).enabled, false);
    assert.ok(await login(s.base), "mot de passe seul accepté");
  } finally { s.stop(); t.done(); }
});

test("2FA facultative : base existante avec données après migration → toujours désactivée", async () => {
  const t = tempDb();
  // Base « existante » : un site et un projet déjà présents, aucune ligne twofa.
  seed(t.path, `import "@server/projects.ts";
    import { db } from "@server/db.ts";
    db.prepare("INSERT INTO sites (id, domain, name, created_at) VALUES ('old', 'ancien.test', 'Ancien', 0)").run();
    db.prepare("INSERT INTO projects (id, name, position, created_at) VALUES ('p-old', 'Projet existant', 0, 0)").run();`);
  const s = await startServer(t.path);
  try {
    const cfg = await (await fetch(`${s.base}/api/auth-config`)).json();
    assert.equal(cfg.totp, false, "la migration n'active rien");
    assert.ok(await login(s.base), "connexion mot de passe seul");
    const sites = await (await fetch(`${s.base}/api/sites`, { headers: { Cookie: await login(s.base) } })).json();
    assert.equal(sites.length, 1, "données existantes intactes");
  } finally { s.stop(); t.done(); }
});

test("2FA facultative : après activation puis désactivation, mot de passe seul de nouveau accepté", async () => {
  const t = tempDb();
  const s = await startServer(t.path);
  try {
    const { totp } = await import("./security.ts");
    const cookie = await login(s.base);
    const h = { Cookie: cookie, "content-type": "application/json" };
    const setup = await (await fetch(`${s.base}/api/2fa/setup`, { method: "POST", headers: h })).json();
    const act = await (await fetch(`${s.base}/api/2fa/activate`, { method: "POST", headers: h, body: JSON.stringify({ code: totp(setup.secret) }) })).json();
    await assert.rejects(login(s.base), /connexion refusée/, "après activation, un code est exigé");
    const cookie2 = await (await fetch(`${s.base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "motdepasse-de-test", code: act.codes[1] }) })).headers.getSetCookie?.() ?? [];
    const h2 = { Cookie: cookie2.map((c) => c.split(";")[0]).join("; "), "content-type": "application/json" };
    await fetch(`${s.base}/api/2fa/disable`, { method: "POST", headers: h2, body: JSON.stringify({ password: "motdepasse-de-test", code: act.codes[2] }) });
    assert.ok(await login(s.base), "désactivée : mot de passe seul");
    // Réactivation volontaire : last_step repart du nouveau pas d'activation.
    const c2 = await login(s.base);
    const h3 = { Cookie: c2, "content-type": "application/json" };
    const setup2 = await (await fetch(`${s.base}/api/2fa/setup`, { method: "POST", headers: h3 })).json();
    assert.equal((await fetch(`${s.base}/api/2fa/activate`, { method: "POST", headers: h3, body: JSON.stringify({ code: totp(setup2.secret) }) })).status, 200, "réactivation");
  } finally { s.stop(); t.done(); }
});

test("2FA facultative : l'avertissement de démarrage respecte Réglages, TOTP_SECRET, la démo et QUIET", () => {
  const base = { inContainer: false, hostname: "0.0.0.0", envTotp: false, configured: false, demo: false, quiet: false };
  assert.match(missing2faWarning(base) ?? "", /facultative.*recommandé/i);
  assert.equal(missing2faWarning({ ...base, configured: true }), null, "2FA des Réglages active : pas d'avertissement");
  assert.equal(missing2faWarning({ ...base, envTotp: true }), null);
  assert.equal(missing2faWarning({ ...base, quiet: true }), null);
  assert.equal(missing2faWarning({ ...base, demo: true }), null);
  assert.equal(missing2faWarning({ ...base, hostname: "127.0.0.1" }), null);
  assert.equal(missing2faWarning({ ...base, inContainer: true }), null);
});
