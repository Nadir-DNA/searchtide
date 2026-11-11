// Tâches de fond : un seul ordonnanceur pour tout le serveur. Chaque tâche appartient à un module et ne tourne que s'il est actif.
// Dernière exécution, durée et erreur sont gardées dans la table jobs : visibles dans Réglages et par MCP (jobs_status).
import { db } from "./db.ts";
import { migrate } from "./migrations.ts";
import { isEnabled } from "./modules/state.ts";
import { allModules, type Job } from "./modules/index.ts";
import { scrub } from "./vault.ts";

type Row = Record<string, any>;
migrate("2026-11-10-jobs", `CREATE TABLE jobs (id TEXT PRIMARY KEY, module TEXT NOT NULL, every TEXT NOT NULL, last_run INTEGER, duration_ms INTEGER,
  ok INTEGER, error TEXT, fails INTEGER NOT NULL DEFAULT 0)`);

export type Every = { kind: "interval"; ms: number } | { kind: "daily"; hourUtc: number; minute: number };

/** "30m", "6h" ou "daily@02:30" (heure UTC). */
export function parseEvery(s: string): Every {
  const i = /^(\d+)(m|h)$/.exec(s);
  if (i && Number(i[1]) > 0) return { kind: "interval", ms: Number(i[1]) * (i[2] === "m" ? 60_000 : 3_600_000) };
  const d = /^daily@(\d{2}):(\d{2})$/.exec(s);
  if (d && Number(d[1]) < 24 && Number(d[2]) < 60) return { kind: "daily", hourUtc: Number(d[1]), minute: Number(d[2]) };
  throw new Error(`Période de tâche invalide : ${s} (ex. 30m, 6h, daily@02:30)`);
}

export function isDue(every: string, lastRun: number | null, now: number): boolean {
  const e = parseEvery(every);
  if (e.kind === "interval") return lastRun == null || now - lastRun >= e.ms;
  const d = new Date(now);
  const slot = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), e.hourUtc, e.minute);
  return now >= slot && (lastRun == null || lastRun < slot);
}

const registered = new Map<string, Job & { module: string }>();

/** Déclare une tâche d'un module livré (les modules privés passent par Module.jobs). */
export function registerJob(module: string, job: Job) {
  parseEvery(job.every);
  registered.set(job.id, { ...job, module });
  db.prepare("INSERT INTO jobs (id, module, every) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET module = excluded.module, every = excluded.every").run(job.id, module, job.every);
}

const allJobs = () => [...registered.values(), ...allModules().flatMap((m) => (m.jobs ?? []).map((j) => ({ ...j, module: m.id })))];

export async function runJob(id: string, now = Date.now()) {
  const job = allJobs().find((j) => j.id === id);
  if (!job) throw new Error(`Tâche inconnue : ${id}`);
  db.prepare("INSERT OR IGNORE INTO jobs (id, module, every) VALUES (?, ?, ?)").run(job.id, job.module, job.every);
  const start = Date.now();
  try {
    await job.run();
    db.prepare("UPDATE jobs SET last_run = ?, duration_ms = ?, ok = 1, error = NULL, fails = 0 WHERE id = ?").run(now, Date.now() - start, id);
  } catch (e) {
    const msg = (e as Error).message.slice(0, 300);
    console.error(`[${id}]`, msg);
    db.prepare("UPDATE jobs SET last_run = ?, duration_ms = ?, ok = 0, error = ?, fails = fails + 1 WHERE id = ?").run(now, Date.now() - start, msg, id);
  }
}

let busy = false;
/** Lance, une à la fois, les tâches dues des modules actifs. */
export async function tick(now = Date.now()) {
  if (busy) return;
  busy = true;
  try {
    for (const j of allJobs()) {
      if (!isEnabled(j.module)) continue;
      const last = (db.prepare("SELECT last_run FROM jobs WHERE id = ?").get(j.id) as Row | undefined)?.last_run ?? null;
      if (isDue(j.every, last, now)) await runJob(j.id, now);
    }
  } finally { busy = false; }
}

/** Démarre l'ordonnanceur (un tic par minute) ; renvoie la fonction d'arrêt. */
export function startJobs(now: () => number = Date.now): () => void {
  const timer = setInterval(() => void tick(now()), 60_000);
  timer.unref();
  return () => clearInterval(timer);
}

const jobSecrets = () => [process.env.SECRET, process.env.ADMIN_PASSWORD, process.env.API_KEY, process.env.API_KEY_READ, process.env.NTFY_TOPIC, process.env.BACKUP_TOKEN].filter((x): x is string => !!x);
const TOKEN = /\b(?:sk|rk|pk|ck|ghp|gho|xox[bap]|whsec)_[A-Za-z0-9_-]{4,}/g;
const cleanError = (e: unknown) => (typeof e === "string" ? scrub(e, jobSecrets()).replace(TOKEN, "•••") : e);

export const jobsStatus = (): Row[] => (db.prepare("SELECT id, module, every, last_run, duration_ms, ok, error, fails FROM jobs ORDER BY module, id").all() as Row[])
  .map((j) => ({ ...j, error: cleanError(j.error) }));

/** Alertes du portefeuille : une tâche en échec trois fois de suite. */
export const jobAlerts = () => jobsStatus().filter((j) => j.fails >= 3 && isEnabled(j.module))
  .map((j) => ({ tone: "bad" as const, project: null, text: `Tâche « ${j.id} » en échec ${j.fails} fois de suite : ${j.error}`, to: { view: "settings" } }));
