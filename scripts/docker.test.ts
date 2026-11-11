// Image Docker : contrôles statiques toujours actifs ; construction et essai réels avec DOCKER_TESTS=1 (lent, réseau requis).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = (f: string) => readFileSync(resolve(root, f), "utf8");

test("Docker : exécution non root, navigateur optionnel, profil seccomp valide, compose d'option", () => {
  const df = read("Dockerfile");
  assert.match(df, /^USER node$/m, "exécution non root");
  assert.match(df, /^ARG WITH_BROWSER=0$/m, "Chromium désactivé par défaut");
  assert.match(df, /apk add --no-cache chromium/);
  assert.doesNotMatch(df, /--no-sandbox/, "jamais de Chromium sans bac à sable");
  const profile = JSON.parse(read("docker/chromium-seccomp.json"));
  assert.ok(profile.syscalls.some((s: any) => s.action === "SCMP_ACT_ALLOW" && s.names?.includes("unshare") && !s.args), "profil : espaces de noms utilisateur autorisés");
  const compose = read("docker-compose.browser.yml");
  assert.match(compose, /WITH_BROWSER: "1"/); assert.match(compose, /shm_size: 1gb/); assert.match(compose, /chromium-seccomp\.json/);
  assert.doesNotMatch(read("docker-compose.yml"), /WITH_BROWSER|seccomp/, "option absente du compose par défaut");
});

test("Docker (DOCKER_TESTS=1) : construction avec navigateur, utilisateur non root, Chromium démarre avec son bac à sable", { skip: process.env.DOCKER_TESTS !== "1" }, () => {
  const tag = `searchtide:test-${process.pid}`;
  const sh = (args: string[], opts: { input?: string } = {}) => execFileSync("docker", args, { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...opts });
  try {
    sh(["build", "-q", "--build-arg", "WITH_BROWSER=1", "-t", tag, "."]);
    assert.equal(sh(["run", "--rm", tag, "id", "-u"]).trim(), "1000");
    const probe = `import { chromium } from "playwright-core"; import { chromiumExecutable } from "./server/browser/pool.ts";
      const b = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: chromiumExecutable() });
      const p = await b.newPage(); await p.setContent("<h1>ok</h1>"); console.log("SANDBOX_OK " + await p.locator("h1").innerText()); await b.close();`;
    const out = sh(["run", "--rm", "--shm-size=1g", "--security-opt", `seccomp=${resolve(root, "docker/chromium-seccomp.json")}`, tag, "node", "--no-warnings", "--input-type=module", "-e", probe]);
    assert.match(out, /SANDBOX_OK ok/);
  } finally { try { sh(["rmi", "-f", tag]); } catch { /* image déjà absente */ } }
});
