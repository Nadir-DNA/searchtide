// Aides pour les tests : lancer le vrai serveur dans un processus fils (base temporaire, port libre) et y préparer des données.
// Utilisé seulement par les tests ; aucun fournisseur n'est joint.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SECRET_40 = "h".repeat(40);
export const freePort = () => new Promise<number>((res) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => res(p)); }); });

/** Dossier temporaire et chemin de base, à supprimer avec `done()`. */
export function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "st-test-"));
  return { dir, path: join(dir, "t.db"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Exécute un petit programme (ESM) dans un processus fils qui partage la base : pour y créer des données avant de lancer le serveur. */
export function seed(dbPath: string, program: string, env: Record<string, string> = {}) {
  const root = new URL("./", import.meta.url).href;
  execFileSync(process.execPath, ["--input-type=module", "-e", program.replaceAll("@server/", root)], { env: { ...process.env, DATABASE_PATH: dbPath, SECRET: SECRET_40, ...env }, stdio: "pipe" });
}

export type Running = { base: string; stop: () => void; child: ChildProcess };
export async function startServer(dbPath: string, env: Record<string, string> = {}): Promise<Running> {
  const child = spawn(process.execPath, ["server/index.ts"], {
    env: { ...process.env, PORT: "0", HOST: "127.0.0.1", DATABASE_PATH: dbPath, SECRET: SECRET_40, ADMIN_PASSWORD: "motdepasse-de-test", // TRUST_PROXY=1 par défaut pour isoler les tests par X-Forwarded-For ; un test du comportement
    // « sans proxy » doit passer TRUST_PROXY: "" explicitement (sinon il ne prouve rien).
    API_KEY: "cle-api-de-test-0001", DEMO: "", NODE_ENV: "test", TRUST_PROXY: "1", ...env },
    stdio: "pipe",
  });
  // Le serveur annonce son port réel : plus de course freePort() entre fichiers parallèles.
  const base = await new Promise<string>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`port du serveur de test non annoncé après 20 s : ${output.slice(-300)}`)), 20_000);
    const onData = (d: Buffer) => {
      output += String(d);
      const m = /\[Searchtide\] PORT=(\d+)/.exec(output);
      if (m) { clearTimeout(timer); resolve(`http://127.0.0.1:${m[1]}`); }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`serveur de test arrêté (code ${code}) avant annonce du port : ${output.slice(-300)}`)); });
  }).catch((e) => { child.kill(); throw e; });
  let ready = false;
  for (let i = 0; i < 150; i++) { try { if ((await fetch(`${base}/healthz`)).ok) { ready = true; break; } } catch { /* pas encore prêt */ } await new Promise((r) => setTimeout(r, 100)); }
  if (!ready) { child.kill(); throw new Error(`serveur de test non prêt sur ${base} après 15 s`); }
  return { base, child, stop: () => child.kill() };
}

/** Ouvre une session administrateur et renvoie l'en-tête Cookie. */
export async function login(base: string, password = "motdepasse-de-test") {
  const r = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
  if (r.status !== 200) throw new Error(`connexion refusée (${r.status})`);
  return (r.headers.getSetCookie?.() ?? [r.headers.get("set-cookie") ?? ""]).map((c) => c.split(";")[0]).join("; ");
}
