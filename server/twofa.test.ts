// 1.4 : activation, anti-rejeu TOTP (séquentiel et concurrent), codes de secours, 403 clés, 429, non-consommation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { base32Encode, totp } from "./security.ts";
import { consumeTotp } from "./twofa.ts";
import { login, startServer, tempDb } from "./test-server.ts";

const ip = (n: string) => ({ "x-forwarded-for": n });
// Pas de 31 s : un pas suivant, sans dépendre de la seconde exacte.
const codeAt = (secret: string, offset = 0) => totp(secret, Date.now() + offset * 30_000);

test("1.4 : 2FA — activation consommée, rejeu refusé, concurrence, codes de secours, limiteur séparé", async () => {
  const t = tempDb();
  const s = await startServer(t.path, { API_KEY_READ: "cle-lecture-test-0001" });
  const base = s.base;
  const password = "motdepasse-de-test";
  const signIn = (body: Record<string, string>, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ password, ...body }) });
  try {
    const cookie = await login(base);
    const h = { Cookie: cookie, "content-type": "application/json" };
    const setup = await fetch(`${base}/api/2fa/setup`, { method: "POST", headers: { ...h, ...ip("198.51.100.1") } });
    assert.equal(setup.status, 200);
    assert.equal(setup.headers.get("cache-control"), "no-store", "S4 : pas de cache");
    const { secret, qr } = await setup.json();
    assert.match(secret, /^[A-Z2-7]{16,}$/);
    assert.match(qr, /^<svg/);

    // Le code d'activation consomme le pas courant ; le suivant sert à la concurrence.
    const activationCode = codeAt(secret);
    assert.equal((await fetch(`${base}/api/2fa/activate`, { method: "POST", headers: { ...h, ...ip("198.51.100.1") }, body: JSON.stringify({ code: "000000" }) })).status, 400, "code faux refusé");
    const act = await fetch(`${base}/api/2fa/activate`, { method: "POST", headers: { ...h, ...ip("198.51.100.1") }, body: JSON.stringify({ code: activationCode }) });
    assert.equal(act.status, 200);
    const codes: string[] = (await act.json()).codes;
    assert.equal(codes.length, 8);

    // Anti-rejeu : le code d'activation ne peut pas servir à se connecter.
    assert.equal((await signIn({ code: activationCode }, ip("198.51.100.10"))).status, 401, "code d'activation déjà consommé");

    // Consommation atomique : deux connexions simultanées avec le même code, une seule réussit.
    const concurrent = codeAt(secret, 1);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => signIn({ code: concurrent }, ip(`198.51.100.${20 + i}`))));
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 401, 401, 401, 401, 401, 401, 401], "une seule connexion sur huit");
    assert.equal((await signIn({ code: concurrent }, ip("198.51.100.11"))).status, 401, "même code rejoué");

    // S3 : un code de secours n'est pas consommé si le mot de passe est faux.
    assert.equal((await signIn({ password: "faux", code: codes[0] }, ip("198.51.100.14"))).status, 401);
    assert.equal((await signIn({ code: codes[0] }, ip("198.51.100.15"))).status, 200, "code de secours intact après un mauvais mot de passe");
    assert.equal((await signIn({ code: codes[0] }, ip("198.51.100.15"))).status, 401, "puis consommé une seule fois");

    assert.equal((await signIn({}, ip("198.51.100.16"))).status, 401, "la connexion exige un code");

    // Désactivation normale : codes de secours restants (le pas TOTP suivant n'est plus dans la fenêtre).
    const fresh = (await (await signIn({ code: codes[1] }, ip("198.51.100.17"))).headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
    const h2 = { Cookie: fresh, "content-type": "application/json", ...ip("203.0.113.11") };
    assert.equal((await fetch(`${base}/api/2fa/disable`, { method: "POST", headers: h2, body: JSON.stringify({ password, code: "000000" }) })).status, 400, "code invalide");
    assert.equal((await fetch(`${base}/api/2fa/disable`, { method: "POST", headers: h2, body: JSON.stringify({ password, code: codes[2] }) })).status, 200);
    assert.equal((await signIn({}, ip("198.51.100.18"))).status, 200, "désactivée : mot de passe seul");
    const hAfter = { Cookie: await login(base), "content-type": "application/json" };

    // S2 : 5 échecs sur /activate (limiteur 2FA) puis 429 — sans bloquer le login depuis la même IP.
    for (let i = 0; i < 5; i++) assert.equal((await fetch(`${base}/api/2fa/activate`, { method: "POST", headers: { ...hAfter, ...ip("203.0.113.9") }, body: JSON.stringify({ code: "000000" }) })).status, 400);
    assert.equal((await fetch(`${base}/api/2fa/activate`, { method: "POST", headers: { ...hAfter, ...ip("203.0.113.9") }, body: JSON.stringify({ code: "000000" }) })).status, 429);
    assert.equal((await signIn({}, ip("203.0.113.9"))).status, 200, "limiteur 2FA distinct : le login reste possible");

    // S2 : limiteur sur /disable (le budget global 2FA peut couper avant les 5 essais de l'IP).
    const disableStatuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      disableStatuses.push((await fetch(`${base}/api/2fa/disable`, { method: "POST", headers: { ...hAfter, ...ip("203.0.113.10") }, body: JSON.stringify({ password: "faux", code: "000000" }) })).status);
      if (disableStatuses.at(-1) === 429) break;
    }
    assert.equal(disableStatuses[0], 400);
    assert.equal(disableStatuses.at(-1), 429, "le limiteur coupe les essais de désactivation");

    // S6 : 403 pour une clé d'API, une clé en lecture seule et une clé d'agent.
    const agent = await (await fetch(`${base}/api/agents`, { method: "POST", headers: hAfter, body: JSON.stringify({ name: "securite-2fa", all_projects: true }) })).json();
    for (const key of ["cle-api-de-test-0001", "cle-lecture-test-0001", agent.key]) {
      assert.equal((await fetch(`${base}/api/2fa/setup`, { method: "POST", headers: { Authorization: `Bearer ${key}` } })).status, 403, `clé ${key.slice(0, 8)} refusée`);
    }
  } finally { s.stop(); t.done(); }
});

test("SEC-02 : un téléphone en avance consomme le pas suivant, puis le pas courant attend le suivant", () => {
  const secret = base32Encode(randomBytes(20));
  const now = Date.parse("2026-05-01T12:00:00Z");
  const step = Math.floor(now / 30_000);
  const code = (s: number) => totp(secret, s * 30_000);
  assert.equal(consumeTotp(secret, code(step), now), "ok");
  assert.equal(consumeTotp(secret, code(step), now), "replay", "même pas rejoué");
  assert.equal(consumeTotp(secret, code(step + 1), now), "ok", "téléphone en avance : pas suivant accepté");
  assert.equal(consumeTotp(secret, code(step), now + 1_000), "replay", "le pas courant reste refusé");
  assert.equal(consumeTotp(secret, code(step + 2), now + 31_000), "ok", "après 30 s, le pas suivant passe");
});

test("1.4 : TOTP_SECRET d'environnement — anti-rejeu identique, sans réglage en base", async () => {
  const t = tempDb();
  const secret = base32Encode(randomBytes(20));
  const s = await startServer(t.path, { TOTP_SECRET: secret });
  try {
    const password = "motdepasse-de-test";
    const signIn = (code: string) => fetch(`${s.base}/api/login`, { method: "POST", headers: { "content-type": "application/json", ...ip("198.51.100.20") }, body: JSON.stringify({ password, code }) });
    const code = codeAt(secret, 1);
    assert.equal((await signIn(code)).status, 200);
    const replay = await signIn(code);
    assert.equal(replay.status, 401, "rejeu refusé avec TOTP_SECRET");
    assert.match((await replay.json()).error, /déjà utilisé/);
    const cfg = await (await fetch(`${s.base}/api/auth-config`)).json();
    assert.equal(cfg.totp, true);
    // La ligne twofa créée par TOTP_SECRET ne bloque pas une configuration ultérieure dans l'interface.
    s.stop();
    const s2 = await startServer(t.path);
    try {
      assert.equal((await (await fetch(`${s2.base}/api/auth-config`)).json()).totp, false);
      const cookie = await login(s2.base);
      const h = { Cookie: cookie, "content-type": "application/json" };
      const setup = await (await fetch(`${s2.base}/api/2fa/setup`, { method: "POST", headers: h })).json();
      assert.equal((await fetch(`${s2.base}/api/2fa/activate`, { method: "POST", headers: h, body: JSON.stringify({ code: totp(setup.secret) }) })).status, 200, "activation possible après TOTP_SECRET");
    } finally { s2.stop(); }
  } finally { s.stop(); t.done(); }
});
