// T19, CA3 : `.env.example` ne contient que 3 variables actives, et l'instance démarre avec seulement SECRET et ADMIN_PASSWORD dans son .env.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freePort, tempDb } from "./test-server.ts";

const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
const active = example.split("\n").filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l)).map((l) => l.split("=")[0]);

test("CA3 : .env.example contient exactement 3 variables non commentées (SECRET, ADMIN_PASSWORD, PUBLIC_URL)", () => {
  assert.deepEqual(active, ["SECRET", "ADMIN_PASSWORD", "PUBLIC_URL"]);
  assert.match(example, /32 caractères/);
  for (const old of ["STRIPE_CLIENT_ID", "STRIPE_OAUTH_SECRET_KEY", "GOOGLE_SERVICE_ACCOUNT_JSON", "SMTP_URL", "NTFY_TOPIC", "PAGESPEED_KEY", "PLAY_BUCKET"])
    assert.doesNotMatch(example, new RegExp(`^[^#\\n]*${old}`, "m"), `${old} ne doit plus être une variable active`);
  // A7 : le fuseau des journées est documenté, mais reste commenté (pas une variable active).
  assert.match(example, /^# DAY_TZ=Europe\/Paris$/m, "DAY_TZ est documenté dans .env.example");
});

test("CA3 : une instance en production démarre avec un .env qui ne contient que SECRET et ADMIN_PASSWORD, l'administrateur se connecte et peut enregistrer une connexion", async () => {
  const t = tempDb(); const port = await freePort();
  const envFile = join(t.dir, ".env");
  writeFileSync(envFile, `SECRET=${"c".repeat(48)}\nADMIN_PASSWORD=mot-de-passe-de-test\n`);
  // Environnement minimal : uniquement ce que fournit le système (PATH) et l'infrastructure du test (port, base temporaire)
  const child = spawn(process.execPath, [`--env-file=${envFile}`, "server/index.ts"], { env: { PATH: process.env.PATH ?? "", PORT: String(port), HOST: "127.0.0.1", DATABASE_PATH: t.path, NODE_ENV: "production" }, stdio: "pipe" });
  let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 150; i++) { try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* pas encore prêt */ } await new Promise((r) => setTimeout(r, 100)); }
    assert.equal((await fetch(`${base}/healthz`)).status, 200, log);
    const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "mot-de-passe-de-test" }) });
    assert.equal(login.status, 200);
    const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
    const cat = await (await fetch(`${base}/api/connectors`, { headers: { Cookie: cookie } })).json();
    assert.equal(cat.vault.ok, true, "le SECRET du .env suffit à ouvrir le coffre");
    assert.equal(cat.connectors.filter((c: any) => !c.builtin).length, 10);
    // Depuis T24, l'absence de SECRET n'est plus un refus : la valeur est générée. Un SECRET explicitement
    // trop court reste refusé (message clair, pas de coffre à moitié actif).
    const bad = spawn(process.execPath, ["server/index.ts"], { env: { PATH: process.env.PATH ?? "", PORT: String(await freePort()), HOST: "127.0.0.1", DATABASE_PATH: t.path, NODE_ENV: "production", SECRET: "court", ADMIN_PASSWORD: "x" }, stdio: "pipe" });
    let err = ""; bad.stderr.on("data", (d) => (err += d));
    const code = await new Promise<number | null>((r) => bad.on("close", r));
    assert.notEqual(code, 0); assert.match(err, /SECRET \(32 caractères au moins\)/);
  } finally { child.kill(); t.done(); }
});
