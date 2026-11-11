// SEC-03 : cookie révocable (logout, activation 2FA, changement de mot de passe) ; SEC-04 : fail-closed et rotation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { totp } from "./security.ts";
import { login, seed, startServer, tempDb } from "./test-server.ts";

const A = "a".repeat(40), B = "b".repeat(40);

test("SEC-03 : l'ancien cookie est refusé après logout ; la session qui active la 2FA reste valide", async () => {
  const t = tempDb();
  let s = await startServer(t.path);
  try {
    const old = await login(s.base);
    assert.equal((await fetch(`${s.base}/api/me`, { headers: { Cookie: old } })).status, 200);
    assert.equal((await fetch(`${s.base}/api/logout`, { method: "POST", headers: { Cookie: old } })).status, 200);
    assert.equal((await fetch(`${s.base}/api/me`, { headers: { Cookie: old } })).status, 401, "cookie révoqué");

    const before = await login(s.base);
    const h = { Cookie: before, "content-type": "application/json" };
    const setup = await (await fetch(`${s.base}/api/2fa/setup`, { method: "POST", headers: h })).json();
    const act = await fetch(`${s.base}/api/2fa/activate`, { method: "POST", headers: h, body: JSON.stringify({ code: totp(setup.secret) }) });
    assert.equal(act.status, 200);
    assert.equal((await fetch(`${s.base}/api/me`, { headers: { Cookie: before } })).status, 401, "cookie antérieur à l'activation révoqué");
    const fresh = (act.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
    assert.equal((await fetch(`${s.base}/api/me`, { headers: { Cookie: fresh } })).status, 200, "session courante réémise");
  } finally { s.stop(); t.done(); }
});

test("SEC-03 : changer ADMIN_PASSWORD invalide les cookies existants", async () => {
  const t = tempDb();
  let s = await startServer(t.path);
  try {
    const old = await login(s.base);
    s.stop();
    s = await startServer(t.path, { ADMIN_PASSWORD: "nouveau-mot-de-passe" });
    assert.equal((await fetch(`${s.base}/api/me`, { headers: { Cookie: old } })).status, 401);
    const fresh = await login(s.base, "nouveau-mot-de-passe");
    assert.equal((await fetch(`${s.base}/api/me`, { headers: { Cookie: fresh } })).status, 200);
  } finally { s.stop(); t.done(); }
});

test("SEC-04 : SECRET changé sans SECRET_OLD → 2FA active mais illisible, connexion 503", async () => {
  const t = tempDb();
  let s = await startServer(t.path, { SECRET: A });
  try {
    const cookie = await login(s.base, "motdepasse-de-test");
    const h = { Cookie: cookie, "content-type": "application/json" };
    const setup = await (await fetch(`${s.base}/api/2fa/setup`, { method: "POST", headers: h })).json();
    assert.equal((await fetch(`${s.base}/api/2fa/activate`, { method: "POST", headers: h, body: JSON.stringify({ code: totp(setup.secret) }) })).status, 200);
    s.stop();
    s = await startServer(t.path, { SECRET: B });
    const cfg = await (await fetch(`${s.base}/api/auth-config`)).json();
    assert.equal(cfg.totp, true, "la 2FA reste active");
    const r = await fetch(`${s.base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "motdepasse-de-test" }) });
    assert.equal(r.status, 503, "jamais 200 sans second facteur lisible");
  } finally { s.stop(); t.done(); }
});

test("SEC-04 : rotation de SECRET avec SECRET_OLD → TOTP et code de secours restent valides", async () => {
  const t = tempDb();
  let s = await startServer(t.path, { SECRET: A });
  let secret = "", backup = "";
  try {
    const cookie = await login(s.base, "motdepasse-de-test");
    const h = { Cookie: cookie, "content-type": "application/json" };
    const setup = await (await fetch(`${s.base}/api/2fa/setup`, { method: "POST", headers: h })).json();
    secret = setup.secret;
    const act = await (await fetch(`${s.base}/api/2fa/activate`, { method: "POST", headers: h, body: JSON.stringify({ code: totp(secret) }) })).json();
    backup = act.codes[0];
    s.stop();
    // Fixture : le dernier pas est remis à zéro pour pouvoir tester un TOTP courant après rotation.
    seed(t.path, `import { db } from "@server/db.ts"; db.prepare("UPDATE twofa SET last_step = 0").run();`);
    s = await startServer(t.path, { SECRET: B, SECRET_OLD: A });
    const body = (code: string) => JSON.stringify({ password: "motdepasse-de-test", code });
    const hh = { "content-type": "application/json" };
    assert.equal((await fetch(`${s.base}/api/login`, { method: "POST", headers: hh, body: body(totp(secret)) })).status, 200, "TOTP après rotation");
    assert.equal((await fetch(`${s.base}/api/login`, { method: "POST", headers: hh, body: body(backup) })).status, 200, "code de secours après rotation (sel indépendant de SECRET)");
  } finally { s.stop(); t.done(); }
});

test("SEC-04 : rotation d'un secret d'activation en attente (pending)", async () => {
  const t = tempDb();
  let s = await startServer(t.path, { SECRET: A });
  let secret = "";
  try {
    const cookie = await login(s.base, "motdepasse-de-test");
    const h = { Cookie: cookie, "content-type": "application/json" };
    const setup = await (await fetch(`${s.base}/api/2fa/setup`, { method: "POST", headers: h })).json();
    secret = setup.secret;
    s.stop();
    s = await startServer(t.path, { SECRET: B, SECRET_OLD: A });
    const fresh = await login(s.base, "motdepasse-de-test");
    const act = await fetch(`${s.base}/api/2fa/activate`, { method: "POST", headers: { Cookie: fresh, "content-type": "application/json" }, body: JSON.stringify({ code: totp(secret) }) });
    assert.equal(act.status, 200, "pending rechiffré et activable");
  } finally { s.stop(); t.done(); }
});
