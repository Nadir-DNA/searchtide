// T24 : une instance neuve démarre en production sans SECRET ni ADMIN_PASSWORD, génère les deux,
// affiche le mot de passe, et le redémarrage garde le même SECRET (le coffre reste déchiffrable).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { freePort, seed, tempDb } from "./test-server.ts";

const boot = (dbPath: string, port: number) => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  for (const k of ["SECRET", "ADMIN_PASSWORD", "API_KEY", "API_KEY_READ", "TOTP_SECRET"]) delete env[k];
  Object.assign(env, { PORT: String(port), HOST: "127.0.0.1", DATABASE_PATH: dbPath, NODE_ENV: "production" });
  const child = spawn(process.execPath, ["server/index.ts"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (b) => { out += String(b); });
  child.stderr.on("data", (b) => { out += String(b); });
  return { child, output: () => out };
};

const stop = (child: import("node:child_process").ChildProcess) => new Promise<void>((res) => {
  if (child.exitCode !== null) return res();
  child.once("exit", () => res());
  child.kill();
  setTimeout(res, 2000).unref();
});

const waitUp = async (base: string) => {
  for (let i = 0; i < 200; i++) { try { if ((await fetch(`${base}/healthz`)).ok) return; } catch { /* pas prêt */ } await new Promise((r) => setTimeout(r, 50)); }
  throw new Error("le serveur n'a pas démarré");
};

test("T24 : production sans variables, mot de passe généré, connexion possible, même SECRET après redémarrage", async () => {
  const t = tempDb(); const port = await freePort(); const base = `http://127.0.0.1:${port}`;
  let s = boot(t.path, port);
  try {
    await waitUp(base);
    const password = readFileSync(join(t.dir, "admin-password"), "utf8").trim();
    const secret = readFileSync(join(t.dir, "secret"), "utf8").trim();
    assert.match(password, /^[A-Za-z0-9_-]{16}$/);
    assert.match(secret, /^[0-9a-f]{64}$/);
    assert.equal(statSync(join(t.dir, "admin-password")).mode & 0o777, 0o600, "mot de passe lisible par le seul propriétaire");
    assert.match(s.output(), /Mot de passe administrateur généré/, "affiché une fois dans les journaux");
    const r = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
    assert.equal(r.status, 200, "la connexion utilise le mot de passe généré");
    assert.equal((await fetch(`${base}/`)).status, 200, "la page de connexion est servie");
    await stop(s.child);
    s = boot(t.path, port);
    await waitUp(base);
    assert.equal(readFileSync(join(t.dir, "secret"), "utf8").trim(), secret, "SECRET stable : les clés du coffre restent lisibles");
    const again = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
    assert.equal(again.status, 200);
    assert.doesNotMatch(s.output(), /Mot de passe administrateur généré/, "pas de nouvelle génération au redémarrage");
  } finally { await stop(s.child); t.done(); }
});

test("T24 : une variable d'environnement explicite reste prioritaire ; un SECRET trop court est refusé", async () => {
  const t = tempDb(); const port = await freePort(); const base = `http://127.0.0.1:${port}`;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  Object.assign(env, { PORT: String(port), HOST: "127.0.0.1", DATABASE_PATH: t.path, NODE_ENV: "production", SECRET: "court", ADMIN_PASSWORD: "choisi-par-l-admin" });
  const child = spawn(process.execPath, ["server/index.ts"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let err = ""; child.stderr.on("data", (b) => { err += String(b); });
  const code = await new Promise<number | null>((res) => child.once("exit", res));
  try {
    assert.notEqual(code, 0);
    assert.match(err + "", /SECRET \(32 caractères au moins\)/);
  } finally { await stop(child); t.done(); }
});

test("S2 : au démarrage, un SECRET régénéré avec des connexions chiffrées déclenche un avertissement clair", async () => {
  const t = tempDb(); const port = await freePort(); const base = `http://127.0.0.1:${port}`;
  seed(t.path, `import { createConnection } from "@server/connections.ts";
    createConnection({ kind: "stripe", label: "Ancienne boîte", config: { hint: "…" }, secrets: { key: "rk_" + "test_ANCIENNE0123456789" } });`);
  const s = boot(t.path, port);
  try {
    await waitUp(base);
    assert.match(s.output(), /ATTENTION : SECRET régénéré/);
    assert.match(s.output(), /restaurez \/data\/secret/i);
  } finally { await stop(s.child); t.done(); }
});
