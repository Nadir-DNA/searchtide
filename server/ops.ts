// Exploitation : notifications (téléphone via ntfy, e-mail), sauvegarde hors du PC, alertes sur les chiffres.
import type { Hono } from "hono";
import { registerJob } from "./jobs.ts";
import { isAdmin } from "./admin.ts";
import { recentSecurityEvents, securityEvent } from "./security-events.ts";
import { existsSync, readdirSync, readFileSync, statfsSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { clientIp } from "./net.ts";
import { blocked, fail, resetIp } from "./security-limits.ts";
import { mailSetup, ntfySetup } from "./connectors/channels.ts";
import { ntfyPublish } from "./connectors/ntfy.ts";
import { currentCtx } from "./connectors/use.ts";
import { db, localDay } from "./db.ts";
import { backupEncrypted, backupBundle } from "./security.ts";
import { backupPassphrase, setBackupPassphrase } from "./backup-settings.ts";
import { createHash } from "node:crypto";
import { lastDays } from "./stats.ts";
import { listProjects } from "./projects.ts";

type Row = Record<string, any>;
const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;
const BACKUP_DIR = process.env.BACKUP_DIR ?? (process.env.DATABASE_PATH?.startsWith("/data/") ? "/data/backups" : "data/backups");
db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)");
const getSetting = (k: string) => (db.prepare("SELECT value FROM settings WHERE key = ?").get(k) as Row | undefined)?.value as string | undefined;
const setSetting = (k: string, v: string) => db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, v);

export async function notify(title: string, message: string, priority: "default" | "high" = "default") {
  const jobs: Promise<unknown>[] = [];
  const n = ntfySetup();
  if (n) jobs.push(ntfyPublish(n, { title, message, priority: priority === "high" ? 5 : 3, click: process.env.PUBLIC_URL || undefined }, currentCtx().fetch));
  const m = mailSetup();
  if (m?.to && priority === "high") jobs.push(m.transport.sendMail({ from: m.from, to: m.to, subject: `[Searchtide] ${title}`, text: message }));
  const res = await Promise.allSettled(jobs);
  for (const r of res) if (r.status === "rejected") console.error("[notification]", r.reason?.message);
}

/**
 * Envoie la dernière sauvegarde COMPLÈTE (base + SECRET + admin-password, déjà compressée) vers le Worker de veille.
 * Une base seule ne suffirait pas : sans SECRET, les connexions seraient indéchiffrables après restauration.
 */
export async function offsiteBackup() {
  if (!process.env.BACKUP_URL || !process.env.BACKUP_TOKEN) throw new Error("BACKUP_URL et BACKUP_TOKEN absents de .env");
  const passphrase = backupPassphrase();
  if (!passphrase) throw new Error("Copie externe refusée : définissez BACKUP_PASSPHRASE (ou le réglage de sauvegarde) pour chiffrer le lot");
  const { bytes: body } = backupEncrypted(BACKUP_DIR, passphrase);
  const res = await fetch(`${process.env.BACKUP_URL}/backup`, { method: "POST", headers: { Authorization: `Bearer ${process.env.BACKUP_TOKEN}` }, body: body as unknown as BodyInit });
  if (!res.ok) throw new Error(`Sauvegarde externe refusée : ${res.status} ${await res.text()}`);
  const r = await res.json() as Row;
  setSetting("backup_offsite", JSON.stringify({ at: Date.now(), bytes: body.length }));
  return r;
}

// ── Alertes sur les chiffres (une seule fois par sujet et par période) ──
const once = async (key: string, title: string, message: string, priority: "default" | "high" = "default") => {
  if (getSetting(`alert:${key}`)) return false;
  setSetting(`alert:${key}`, String(Date.now()));
  await notify(title, message, priority);
  return true;
};

export async function checkAlerts(now = new Date()) {
  const today = localDay(now);
  const week = lastDays(7, now);
  const fired: string[] = [];
  for (const p of listProjects(week)) {
    for (const i of p.indicators as Row[]) {
      // Relevé en échec depuis plus de 24 h
      if (i.last_error && i.last_run) {
        const failingSince = Number(getSetting(`failing:${i.id}`) ?? 0) || (setSetting(`failing:${i.id}`, String(i.last_run)), i.last_run);
        if (Date.now() - failingSince > 86400000 && await once(`error:${i.id}:${today}`, `${p.name} : relevé en erreur`, `« ${i.label} » ne se met plus à jour : ${i.last_error}`)) fired.push(`erreur ${i.label}`);
      } else db.prepare("DELETE FROM settings WHERE key = ?").run(`failing:${i.id}`);
      // Baisse de plus de 30 % sur 7 jours, sur un volume significatif
      if (i.mode === "daily" && i.previous >= 10 && i.value != null && i.value < i.previous * 0.7
        && await once(`drop:${i.id}:${week.from}`, `${p.name} : ${i.label} en baisse`, `${i.label} : ${i.value} sur 7 jours contre ${i.previous} la semaine d'avant (${Math.round((i.value / i.previous - 1) * 100)} %).`, "high")) fired.push(`baisse ${i.label}`);
      // Nouvelle vente du jour (indicateurs Stripe de chiffre d'affaires)
      if (i.source === "stripe" && i.config?.metric === "revenue") {
        const v = i.series.at(-1)?.day === today ? i.series.at(-1)?.value ?? 0 : 0;
        const seen = Number(getSetting(`sales:${i.id}:${today}`) ?? 0);
        if (v > seen) {
          setSetting(`sales:${i.id}:${today}`, String(v));
          await notify(`${p.name} : nouvelle vente`, `${(v - seen).toLocaleString("fr-FR")} ${i.unit ?? "€"} encaissés (${v.toLocaleString("fr-FR")} ${i.unit ?? "€"} aujourd'hui).`);
          fired.push(`vente ${p.name}`);
        }
      }
    }
  }
  // Relances CRM du jour, chaque matin
  const todo = (db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE next_at <= ? AND opt_out = 0 AND stage NOT IN ('won', 'lost')").get(today) as Row).n;
  if (todo && now.getUTCHours() >= 6 && await once(`todo:${today}`, `${todo} relance${todo > 1 ? "s" : ""} à faire`, "Ouvrez « Contacts › À relancer » dans le tableau de bord.")) fired.push("relances");
  return fired;
}

/** Vérifie à blanc le dernier lot local (v2 chiffré en priorité, sinon v1). */
export function verifyLastBackup(): { ok: boolean; detail: string } {
  const files = (() => { try { return readdirSync(BACKUP_DIR); } catch { return []; } })();
  const latest = (suffix: string) => files.filter((f) => f.endsWith(suffix)).sort().at(-1);
  const name = latest(".bundle.v2") ?? latest(".bundle.json.gz");
  if (!name) return { ok: false, detail: "aucune sauvegarde locale" };
  try {
    const out = execFileSync(process.execPath, ["scripts/backup-verify.mjs", join(BACKUP_DIR, name), process.env.DATABASE_PATH ?? "data/searchtide.db"], {
      encoding: "utf8", env: { ...process.env, BACKUP_PASSPHRASE: backupPassphrase() ?? "" }, stdio: "pipe",
    });
    const r = JSON.parse(out.trim().split("\n").at(-1) ?? "{}");
    return { ok: !!r.ok, detail: r.ok ? `integrity ${r.integrity}, ${r.tables} tables, connexion ${r.connection}` : String(r.error ?? "échec") };
  } catch (e) { return { ok: false, detail: (e as Error).message }; }
}

export function registerOps(app: Hono) {
  app.get("/api/ops", async (c) => {
    const veille = process.env.BACKUP_URL ? await fetch(`${process.env.BACKUP_URL}/status`).then((r) => r.json()).catch(() => null) : null;
    const local = (() => { try { return readdirSync(BACKUP_DIR).filter((f) => f.endsWith(".db")).sort().reverse(); } catch { return []; } })();
    const migration = (db.prepare("SELECT MAX(applied_at) AS at FROM migrations").get() as Row | undefined)?.at ?? null;
    return c.json({
      ntfy: process.env.NTFY_TOPIC ?? null, ntfyVia: ntfySetup()?.via ?? null, mail: !!mailSetup(), veille,
      version: VERSION, migration, tz: process.env.DAY_TZ ?? "Europe/Paris", docker: existsSync("/.dockerenv"),
      offsiteConfigured: !!(process.env.BACKUP_URL && process.env.BACKUP_TOKEN),
      backups: { local: local.slice(0, 5), dir: BACKUP_DIR, offsite: JSON.parse(getSetting("backup_offsite") ?? "null"), verified: JSON.parse(getSetting("backup_verified") ?? "null"), passphrase: !!backupPassphrase(), passSource: process.env.BACKUP_PASSPHRASE ? "env" : backupPassphrase() ? "settings" : null, passFingerprint: backupPassphrase() ? createHash("sha256").update(backupPassphrase()!).digest("hex").slice(0, 6) : null },
    });
  });
  // A8 : diagnostic réservé à la session administrateur (auth déjà appliquée à /api/*).
  app.get("/api/diagnostic", (c) => {
    if (!isAdmin(c)) return c.json({ error: "Réservé à l'administrateur" }, 403);
    let disk: { free: number; total: number } | null = null;
    // Le dossier de la base existe toujours, même si data/backups n'a pas encore été créé.
    const volume = !process.env.DATABASE_PATH || process.env.DATABASE_PATH === ":memory:" ? "." : dirname(process.env.DATABASE_PATH);
    try { const s = statfsSync(volume); disk = { free: s.bavail * s.bsize, total: s.blocks * s.bsize }; } catch { /* volume illisible */ }
    const jobs = db.prepare("SELECT id, ok, fails, last_run, error FROM jobs ORDER BY id").all();
    return c.json({ version: VERSION, now: Date.now(), tz: process.env.DAY_TZ ?? "Europe/Paris", docker: existsSync("/.dockerenv"), disk, jobs, events: recentSecurityEvents(50) });
  });
  app.post("/api/diagnostic/outbound", async (c) => {
    if (!isAdmin(c)) return c.json({ error: "Réservé à l'administrateur" }, 403);
    // Deux hôtes fixes, 5 s maximum, aucune donnée envoyée.
    const urls = ["https://www.cloudflare.com/cdn-cgi/trace", "https://api.github.com/zen"];
    const results = await Promise.all(urls.map(async (url) => {
      const start = Date.now();
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { "user-agent": "Searchtide-diagnostic" } });
        return { url, ok: r.ok, status: r.status, ms: Date.now() - start };
      } catch (e) { return { url, ok: false, error: (e as Error).name, ms: Date.now() - start }; }
    }));
    return c.json({ results });
  });
  app.post("/api/ops/backup", async (c) => { try { return c.json(await offsiteBackup()); } catch (e) { return c.json({ error: (e as Error).message }, 400); } });
  app.get("/api/ops/backup-passphrase", (c) => {
    if (!isAdmin(c)) return c.json({ error: "Réservé à l'administrateur" }, 403);
    const pass = backupPassphrase();
    return c.json({ configured: !!pass, source: process.env.BACKUP_PASSPHRASE ? "env" : pass ? "settings" : null,
      fingerprint: pass ? createHash("sha256").update(pass).digest("hex").slice(0, 6) : null });
  });
  app.post("/api/ops/backup-passphrase", async (c) => {
    if (!isAdmin(c)) return c.json({ error: "Réservé à l'administrateur" }, 403);
    const ip = clientIp(c);
    if (blocked("twofa", ip)) return c.json({ error: "Trop d'essais : réessayez dans 15 minutes" }, 429);
    const b = await c.req.json().catch(() => ({}));
    const expected = process.env.ADMIN_PASSWORD ?? "";
    const given = typeof b.password === "string" ? b.password : "";
    const ok = given.length === expected.length && !!expected && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
    if (!ok) { fail("twofa", ip); return c.json({ error: "Mot de passe administrateur incorrect" }, 400); }
    try { setBackupPassphrase(b.passphrase === null ? null : String(b.passphrase ?? "")); }
    catch (e) { return c.json({ error: (e as Error).message }, 400); }
    resetIp("twofa", ip);
    securityEvent("backup_passphrase_changed", "réglage");
    const pass = backupPassphrase();
    return c.json({ ok: true, configured: !!pass, source: process.env.BACKUP_PASSPHRASE ? "env" : pass ? "settings" : null,
      fingerprint: pass ? createHash("sha256").update(pass).digest("hex").slice(0, 6) : null });
  });
  app.post("/api/ops/backup/verify", (c) => {
    if (!isAdmin(c)) return c.json({ error: "Réservé à l'administrateur" }, 403);
    const r = verifyLastBackup();
    setSetting("backup_verified", JSON.stringify({ at: Date.now(), ...r }));
    return c.json(r);
  });
  app.post("/api/ops/test-notification", async (c) => { await notify("Test du tableau de bord", "Les notifications fonctionnent."); return c.json({ ok: true }); });

  // Sauvegarde externe vers 2 h 30 UTC, alertes toutes les 30 min
  // Vérification mensuelle (~30 j) du dernier lot local, résultat dans Diagnostic et Réglages.
  registerJob("projets", { id: "backup-verify", every: "720h", run: async () => {
    const r = verifyLastBackup();
    setSetting("backup_verified", JSON.stringify({ at: Date.now(), ...r }));
    if (!r.ok) await notify("Vérification de sauvegarde en échec", r.detail, "high");
  } });
  registerJob("projets", { id: "offsite-backup", every: "daily@02:30", run: async () => {
    if (!process.env.BACKUP_URL || !process.env.BACKUP_TOKEN) return; // pas de sauvegarde externe configurée : rien à faire
    try { await offsiteBackup(); } catch (e) { await notify("Sauvegarde externe en échec", (e as Error).message, "high"); throw e; }
  } });
  registerJob("notifications", { id: "alerts", every: "30m", run: async () => { await checkAlerts(); } });
}
