// Exploitation : notifications (téléphone via ntfy, e-mail), sauvegarde hors du PC, alertes sur les chiffres.
import type { Hono } from "hono";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { mailSetup, ntfySetup } from "./connectors/channels.ts";
import { ntfyPublish } from "./connectors/ntfy.ts";
import { currentCtx } from "./connectors/use.ts";
import { db, localDay } from "./db.ts";
import { backup } from "./security.ts";
import { lastDays } from "./stats.ts";
import { listProjects } from "./projects.ts";

type Row = Record<string, any>;
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

/** Envoie la dernière sauvegarde (compressée) vers le Worker de veille, qui en garde 30 jours. */
export async function offsiteBackup() {
  if (!process.env.BACKUP_URL || !process.env.BACKUP_TOKEN) throw new Error("BACKUP_URL et BACKUP_TOKEN absents de .env");
  const file = backup(BACKUP_DIR);
  const body = gzipSync(readFileSync(file));
  const res = await fetch(`${process.env.BACKUP_URL}/backup`, { method: "POST", headers: { Authorization: `Bearer ${process.env.BACKUP_TOKEN}` }, body });
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

export function registerOps(app: Hono) {
  app.get("/api/ops", async (c) => {
    const veille = process.env.BACKUP_URL ? await fetch(`${process.env.BACKUP_URL}/status`).then((r) => r.json()).catch(() => null) : null;
    const local = (() => { try { return readdirSync(BACKUP_DIR).filter((f) => f.endsWith(".db")).sort().reverse(); } catch { return []; } })();
    return c.json({
      ntfy: process.env.NTFY_TOPIC ?? null, ntfyVia: ntfySetup()?.via ?? null, mail: !!mailSetup(), veille,
      backups: { local: local.slice(0, 5), dir: BACKUP_DIR, offsite: JSON.parse(getSetting("backup_offsite") ?? "null") },
    });
  });
  app.post("/api/ops/backup", async (c) => { try { return c.json(await offsiteBackup()); } catch (e) { return c.json({ error: (e as Error).message }, 400); } });
  app.post("/api/ops/test-notification", async (c) => { await notify("Test du tableau de bord", "Les notifications fonctionnent."); return c.json({ ok: true }); });

  // Sauvegarde externe vers 2 h 30 UTC, alertes toutes les 30 min
  let lastOffsite = "";
  setInterval(() => {
    const d = new Date();
    if (d.getUTCHours() === 2 && d.getUTCMinutes() >= 30 && lastOffsite !== d.toISOString().slice(0, 10)) {
      lastOffsite = d.toISOString().slice(0, 10);
      offsiteBackup().catch((e) => notify("Sauvegarde externe en échec", (e as Error).message, "high"));
    }
  }, 10 * 60 * 1000).unref();
  setInterval(() => void checkAlerts().catch((e) => console.error("[alertes]", e.message)), 30 * 60 * 1000).unref();
}
