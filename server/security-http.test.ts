// SEC-01 : le limiteur ne dépend pas d'en-têtes falsifiables sans TRUST_PROXY, plafond global,
// échecs Bearer, persistance après redémarrage.
import { test } from "node:test";
import assert from "node:assert/strict";
import { login, startServer, tempDb } from "./test-server.ts";

const bad = (base: string, headers: Record<string, string>) => fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ password: "faux" }) });

test("SEC-01 : X-Forwarded-For tournant sans TRUST_PROXY → 429 dès le 6e échec", async () => {
  const t = tempDb();
  const s = await startServer(t.path, { TRUST_PROXY: "" });
  try {
    for (let i = 1; i <= 5; i++) assert.equal((await bad(s.base, { "x-forwarded-for": `198.51.100.${i}` })).status, 401);
    assert.equal((await bad(s.base, { "x-forwarded-for": "198.51.100.99" })).status, 429);
  } finally { s.stop(); t.done(); }
});

test("SEC-01 : TRUST_PROXY=cloudflare et cf-connecting-ip tournant → plafond global au 16e échec", async () => {
  const t = tempDb();
  const s = await startServer(t.path, { TRUST_PROXY: "cloudflare" });
  try {
    for (let i = 1; i <= 15; i++) assert.equal((await bad(s.base, { "cf-connecting-ip": `203.0.113.${i}` })).status, 401, `essai ${i}`);
    assert.equal((await bad(s.base, { "cf-connecting-ip": "203.0.113.250" })).status, 429);
  } finally { s.stop(); t.done(); }
});

test("SEC-01 : une clé Bearer refusée compte dans le budget de connexion", async () => {
  const t = tempDb();
  const s = await startServer(t.path, { TRUST_PROXY: "" });
  try {
    const key = (i: number) => ({ Authorization: `Bearer inexistante-${i}` });
    for (let i = 1; i <= 5; i++) assert.equal((await fetch(`${s.base}/api/sites`, { headers: key(i) })).status, 401);
    assert.equal((await fetch(`${s.base}/api/sites`, { headers: key(99) })).status, 429);
  } finally { s.stop(); t.done(); }
});

test("SEC-01 : le budget survit à un redémarrage", async () => {
  const t = tempDb();
  let s = await startServer(t.path, { TRUST_PROXY: "" });
  try {
    for (let i = 0; i < 5; i++) assert.equal((await bad(s.base, {})).status, 401);
    s.stop();
    s = await startServer(t.path, { TRUST_PROXY: "" });
    assert.equal((await bad(s.base, {})).status, 429, "toujours bloqué après redémarrage");
  } finally { s.stop(); t.done(); }
});

test("SEC-08 : verrouillage visible dans Diagnostic et Aujourd'hui", async () => {
  const t = tempDb();
  const s = await startServer(t.path, { TRUST_PROXY: "1" });
  try {
    for (let i = 0; i < 5; i++) assert.equal((await bad(s.base, { "x-forwarded-for": "198.51.100.200" })).status, 401);
    const cookie = await login(s.base, "motdepasse-de-test");
    const diag = await (await fetch(`${s.base}/api/diagnostic`, { headers: { Cookie: cookie } })).json();
    assert.ok(diag.events.some((e: { kind: string }) => e.kind === "login_lockout"), "événement présent");
    const today = await (await fetch(`${s.base}/api/today`, { headers: { Cookie: cookie } })).json();
    assert.ok(today.some((i: { text: string }) => /Verrouillage de connexion/.test(i.text)), "alerte Aujourd'hui");
  } finally { s.stop(); t.done(); }
});
