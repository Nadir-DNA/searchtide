#!/usr/bin/env node
// CA60 : déploiement du relais qui refuse de changer de mode par accident.
// Lit le mode courant (/v1/health), le compare à relay/wrangler.toml, déploie,
// puis vérifie que le mode n'a pas changé. `--changer-de-mode` autorise l'écart.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RELAY = join(ROOT, "relay");
const TOML = join(RELAY, "wrangler.toml");

/** Lit `MODE = "…"` dans wrangler.toml. */
export function fileMode(toml) {
  const m = String(toml).match(/^\s*MODE\s*=\s*"([^"]+)"/m);
  return m ? m[1] : null;
}

/** Mode servi par /v1/health, ou null si le relais ne répond pas un mode lisible. */
async function healthMode(fetchImpl, url) {
  try {
    const r = await fetchImpl(`${url.replace(/\/$/, "")}/v1/health`);
    const j = await r.json().catch(() => ({}));
    return r.ok && (j.mode === "live" || j.mode === "test") ? j.mode : null;
  } catch { return null; }
}

export async function deployRelay({
  url = process.env.RELAY_URL ?? "https://connect.nadirdaoudi.com",
  tomlPath = TOML,
  relayDir = RELAY,
  readFile = (p) => readFileSync(p, "utf8"),
  fetchImpl = fetch,
  run = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, stdio: "inherit" }).status ?? 1,
  changeMode = process.argv.includes("--changer-de-mode"),
  log = console.log,
} = {}) {
  const wanted = fileMode(readFile(tomlPath));
  if (!wanted) throw new Error("MODE absent de relay/wrangler.toml");
  const before = await healthMode(fetchImpl, url);
  if (!before) {
    if (!changeMode) throw new Error(`Mode courant illisible sur ${url} ; vérifiez /v1/health ou utilisez --changer-de-mode`);
  } else if (before !== wanted && !changeMode) {
    throw new Error(`Le relais est en « ${before} » et le fichier en « ${wanted} » : utilisez --changer-de-mode pour le changer`);
  }
  log(`Déploiement du relais en « ${wanted} » (mode courant : ${before ?? "inconnu"})…`);
  const status = run("npx", ["wrangler", "deploy"], relayDir);
  if (status !== 0) throw new Error(`wrangler deploy a échoué (code ${status})`);
  const after = await healthMode(fetchImpl, url);
  if (after !== wanted) throw new Error(`Après déploiement, /v1/health annonce « ${after ?? "inconnu"} » au lieu de « ${wanted} » : le mode a changé, arrêt.`);
  log(`Relais déployé en « ${after} ».`);
  return { before, after };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  deployRelay().catch((e) => { console.error(`[deploy:relay] ${e.message}`); process.exit(1); });
}
