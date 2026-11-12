// Lot 1 : configuration de connexion (A4), version et migration (A10), cohérence des versions Docker (A6).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { freePort, login, startServer, tempDb } from "./test-server.ts";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("A4/A10 : /api/auth-config ne livre jamais la valeur, /healthz ne dépend que de ok, /api/ops expose version et migration", async () => {
  const t = tempDb();
  const s = await startServer(t.path);
  try {
    const cfg = await (await fetch(`${s.base}/api/auth-config`)).json();
    assert.equal(cfg.totp, false);
    assert.equal(cfg.passwordGenerated, false, "mot de passe fourni par l'environnement, pas généré");
    assert.equal("password" in cfg, false, "aucune valeur de mot de passe dans la réponse");

    const health = await (await fetch(`${s.base}/healthz`)).json();
    assert.equal(health.ok, true, "seul ok compte pour la surveillance");
    assert.equal(health.version, pkg.version);

    const ops = await (await fetch(`${s.base}/api/ops`, { headers: { Cookie: await login(s.base) } })).json();
    assert.equal(ops.version, pkg.version);
    assert.equal(typeof ops.migration, "number", "date de dernière migration (ms)");
    assert.equal(ops.tz, "Europe/Paris");
    assert.equal(ops.offsiteConfigured, false, "aucune sauvegarde externe configurée");
  } finally { s.stop(); t.done(); }
});

test("A4 : en production sans ADMIN_PASSWORD, passwordGenerated=true et supprimer le fichier régénère un mot de passe utilisable", async () => {
  const t = tempDb(); const port = await freePort(); const base = `http://127.0.0.1:${port}`;
  const boot = () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    for (const k of ["SECRET", "ADMIN_PASSWORD", "API_KEY", "API_KEY_READ", "TOTP_SECRET"]) delete env[k];
    Object.assign(env, { PORT: String(port), HOST: "127.0.0.1", DATABASE_PATH: t.path, NODE_ENV: "production" });
    return spawn(process.execPath, ["server/index.ts"], { env, stdio: "pipe" });
  };
  const waitUp = async () => { for (let i = 0; i < 200; i++) { try { if ((await fetch(`${base}/healthz`)).ok) return; } catch { /* pas prêt */ } await new Promise((r) => setTimeout(r, 50)); } throw new Error("serveur absent"); };
  const stop = (c: import("node:child_process").ChildProcess) => new Promise<void>((res) => { if (c.exitCode !== null) return res(); c.once("exit", () => res()); c.kill(); setTimeout(res, 2000).unref(); });
  let child = boot();
  try {
    await waitUp();
    assert.equal((await (await fetch(`${base}/api/auth-config`)).json()).passwordGenerated, true);
    const first = readFileSync(join(t.dir, "admin-password"), "utf8").trim();
    await stop(child);
    rmSync(join(t.dir, "admin-password"));
    child = boot();
    await waitUp();
    const second = readFileSync(join(t.dir, "admin-password"), "utf8").trim();
    assert.notEqual(second, first, "supprimer le fichier puis redémarrer régénère le mot de passe");
    assert.equal((await (await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: second }) })).json()).ok, true);
  } finally { await stop(child); t.done(); }
});

test("F4 : aucune route de téléchargement de sauvegarde (404 admin, clé de lecture, clé d'agent, démo anonyme)", async () => {
  const t = tempDb();
  const s = await startServer(t.path, { API_KEY_READ: "cle-lecture-test-0001" });
  try {
    const cookie = await login(s.base);
    const url = `${s.base}/api/ops/backup/download`;
    assert.equal((await fetch(url, { headers: { Cookie: cookie } })).status, 404, "administrateur : route absente");
    assert.equal((await fetch(url, { headers: { Authorization: "Bearer cle-lecture-test-0001" } })).status, 403, "clé de lecture : réservé admin");
    const agent = await (await fetch(`${s.base}/api/agents`, { method: "POST", headers: { Cookie: cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "test-f4", all_projects: true }) })).json();
    assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${agent.key}` } })).status, 403, "clé d'agent : réservé admin");
  } finally { s.stop(); }
  const d = await startServer(t.path, { DEMO: "1" });
  try {
    assert.equal((await fetch(`${d.base}/api/ops/backup/download`)).status, 403, "démo anonyme : réservé admin");
  } finally { d.stop(); t.done(); }
});

test("A6 : README et compose annoncent la même version publiée, jamais latest", () => {
  const compose = readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8");
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const tag = compose.match(/ghcr\.io\/nadir-dna\/searchtide:([\w.]+)/)?.[1];
  assert.equal(tag, "0.4.0");
  assert.match(readme, new RegExp("tags `0\\.4\\.0` et `v0\\.4\\.0`"));
  assert.doesNotMatch(readme, /`latest`/);
  assert.match(readme, /--restart unless-stopped/);
});
