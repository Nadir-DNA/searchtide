// Fil « Aujourd'hui » (spec §5.5) : alertes du portefeuille, actions proposées par les modules, jalons proches et objectifs en retard,
// dans une seule liste. Fait, Plus tard et Ignorer sont gardés côté serveur pour que l'interface et les agents voient la même chose.
import { createHash } from "node:crypto";
import type { Hono } from "hono";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { db, localDay } from "./db.ts";
import { migrate } from "./migrations.ts";
import { viewerOf } from "./admin.ts";
import { visibleProjectIds } from "./agents.ts";
import { lastDays, strikingDistance } from "./stats.ts";
import { portfolio } from "./portfolio.ts";
import { upcomingMilestones } from "./projects.ts";
import { gscPropertyFor } from "./gsc.ts";
import { activeModules, enabledFor, isEnabled } from "./modules/state.ts";
import { getModule } from "./modules/index.ts";
import { freshness } from "./freshness.ts";

type Row = Record<string, any>;
migrate("2026-11-10-aujourdhui", "CREATE TABLE today_items (key TEXT PRIMARY KEY, project_id TEXT, state TEXT NOT NULL, until TEXT, updated_at INTEGER NOT NULL)");

export type TodayItem = { key: string; kind: "alerte" | "action" | "jalon" | "objectif"; tone: "bad" | "warn" | "info"; project_id: string | null; text: string; metric?: string; to: Record<string, string>; daysLeft?: number };

export const itemKey = (...parts: string[]) => parts.join(":");
/** Clé stable d'une alerte : les chiffres sont retirés, « en baisse de 31 % » et « de 34 % » restent la même alerte. */
export const alertKey = (a: { project: string | null; text: string }) =>
  itemKey("alerte", a.project ?? "tous", createHash("sha1").update(a.text.replace(/\d+([.,]\d+)?/g, "#")).digest("hex").slice(0, 10));

const nf = (n: number, d = 0) => n.toLocaleString("fr-FR", { maximumFractionDigits: d });
const plural = (n: number, w: string) => `${n} ${w}${n > 1 ? "s" : ""}`;

/** Actions des modules livrés ; un module privé apporte les siennes par Module.actions. */
function builtinActions(moduleId: string, p: Row, today: string): Omit<TodayItem, "kind" | "tone">[] {
  if (moduleId === "google") {
    const r = lastDays(28);
    const rows = (JSON.parse(p.sites) as string[]).filter((d) => gscPropertyFor(d, p.id)).flatMap((d) => {
      const s = db.prepare("SELECT id FROM sites WHERE domain = ?").get(d) as Row | undefined;
      return s ? (strikingDistance(s.id, r, 3) as Row[]).map((x): Row => ({ ...x, domain: d })) : [] as Row[];
    }).sort((a, b) => b.impressions - a.impressions).slice(0, 3);
    return rows.map((x) => ({ key: itemKey("google", "opportunite", p.id, x.query), project_id: p.id, metric: "Clics Google",
      text: `${p.name} · faire monter « ${x.query} » (position ${nf(x.position, 1)}, ${nf(x.impressions)} impressions)`, to: { site: x.domain, tab: "search" } }));
  }
  if (moduleId === "crm" && p.crm_key) {
    const n = (db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE project = ? AND next_at <= ? AND opt_out = 0 AND stage NOT IN ('won', 'lost')").get(p.crm_key, today) as Row).n as number;
    return n ? [{ key: itemKey("crm", "relances", p.id), project_id: p.id, metric: "Contacts gagnés", text: `${p.name} · ${plural(n, "relance")} à faire`, to: { view: "crm", tab: "todo", project: p.crm_key } }] : [];
  }
  return [];
}

function collectItems(now: Date): TodayItem[] {
  const today = localDay(now);
  const projects = db.prepare("SELECT id, name, sites, crm_key FROM projects ORDER BY position, name").all() as Row[];
  const items: TodayItem[] = portfolio(lastDays(7)).alerts.map((a) => ({
    key: alertKey(a), kind: (a as Row).kind === "objectif" ? "objectif" : "alerte", tone: a.tone, project_id: a.project || null, text: a.text, to: a.to }));
  for (const p of projects) for (const m of activeModules(p.id)) {
    const custom = getModule(m.id)?.actions;
    if (custom) continue; // actions asynchrones des modules privés : ajoutées par todayAsync()
    for (const a of builtinActions(m.id, p, today)) items.push({ ...a, kind: "action", tone: "info" });
  }
  // Relances des contacts rattachés à aucun projet connu
  if (isEnabled("crm")) {
    const keys = projects.filter((p) => p.crm_key && enabledFor(p.id, "crm")).map((p) => p.crm_key);
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM contacts WHERE next_at <= ? AND opt_out = 0 AND stage NOT IN ('won', 'lost')
      AND (project IS NULL OR project NOT IN (${keys.map(() => "?").join(",") || "''"}))`).get(today, ...keys) as Row).n as number;
    if (n) items.push({ key: itemKey("crm", "relances", "tous"), kind: "action", tone: "info", project_id: null, text: `${plural(n, "relance")} à faire`, to: { view: "crm", tab: "todo" } });
  }
  const names = new Map(projects.map((p) => [p.id, p.name]));
  for (const m of upcomingMilestones(undefined, 7)) {
    const when = m.daysLeft === 0 ? "aujourd'hui" : m.daysLeft === 1 ? "demain" : `dans ${m.daysLeft} jours`;
    items.push({ key: itemKey("jalon", m.id), kind: "jalon", tone: m.daysLeft <= 1 ? "warn" : "info", project_id: m.project_id, daysLeft: m.daysLeft,
      text: `${m.project_id ? `${names.get(m.project_id) ?? "Projet"} · ` : ""}${m.label} ${when}`, to: m.project_id ? { view: "project", id: m.project_id } : {} });
  }
  // Point 1 : une seule alerte de fraîcheur par projet et par jour.
  const bad = new Map<string, { stale: number; error: number; never: number }>();
  for (const f of freshness(Date.now())) {
    if (f.state === "ok") continue;
    const b = bad.get(f.project_id) ?? { stale: 0, error: 0, never: 0 };
    b[f.state === "stale" ? "stale" : f.state === "error" ? "error" : "never"] += 1;
    bad.set(f.project_id, b);
  }
  for (const [pid, b] of bad) {
    const name = names.get(pid) ?? "Projet";
    const parts = [b.stale ? `${b.stale} périmée${b.stale > 1 ? "s" : ""}` : "", b.error ? `${b.error} en erreur` : "", b.never ? `${b.never} sans donnée` : ""].filter(Boolean);
    items.push({ key: itemKey("sources", pid, today), kind: "alerte", tone: "warn", project_id: pid,
      text: `${name} · sources à vérifier : ${parts.join(", ")}`, to: { view: "project", id: pid } });
  }

  // SEC-08 : verrouillage de connexion et purge remontent dans « Aujourd'hui ».
  const since = Date.now() - 86_400_000;
  const events = db.prepare("SELECT kind, COUNT(*) AS n, MAX(ts) AS last FROM security_events WHERE ts > ? AND kind IN ('login_lockout', 'purge') GROUP BY kind").all(since) as Row[];
  for (const e of events) {
    const lock = e.kind === "login_lockout";
    items.push({
      key: itemKey("securite", e.kind, String(e.last)),
      kind: "alerte",
      tone: lock ? "bad" : "warn",
      project_id: null,
      text: lock
        ? `Verrouillage de connexion (${e.n} événement${Number(e.n) > 1 ? "s" : ""} sur 24 h) : vérifiez les journaux et le mot de passe`
        : `Purge de statistiques effectuée récemment (${e.n} opération${Number(e.n) > 1 ? "s" : ""})`,
      to: { view: "settings" },
    });
  }
  return items;
}

const rank = (i: TodayItem) => i.tone === "bad" ? 0 : i.kind === "jalon" ? 1 : 2;

/** Le fil du jour, sans ce qui est fait aujourd'hui, reporté à plus tard ou ignoré. */
export function today(now = new Date()): TodayItem[] {
  const day = localDay(now);
  const states = new Map((db.prepare("SELECT key, state, until FROM today_items").all() as Row[]).map((r) => [r.key, r]));
  const hidden = (k: string) => {
    const s = states.get(k);
    return !!s && (s.state === "ignored" || (s.state === "snoozed" && s.until > day) || (s.state === "done" && s.until >= day));
  };
  const items = collectItems(now);
  const live = new Set(items.map((i) => i.key));
  for (const [k, s] of states) if (s.state === "ignored" && k.startsWith("alerte:") && !live.has(k)) { db.prepare("DELETE FROM today_items WHERE key = ?").run(k); states.delete(k); }
  return items.filter((i) => !hidden(i.key))
    .sort((a, b) => rank(a) - rank(b) || (a.kind === "jalon" && b.kind === "jalon" ? (a.daysLeft ?? 0) - (b.daysLeft ?? 0) : 0));
}

/** Fait : masqué jusqu'à demain (revient si la situation demeure). Plus tard : revient demain. Ignorer : ne revient plus. */
export function setTodayState(key: string, state: "done" | "snoozed" | "ignored", now = new Date()) {
  const until = state === "snoozed" ? localDay(new Date(now.getTime() + 86400000)) : state === "done" ? localDay(now) : null;
  db.prepare("INSERT INTO today_items (key, project_id, state, until, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET state = excluded.state, until = excluded.until, updated_at = excluded.updated_at")
    .run(key, key.split(":")[2] ?? null, state, until, Date.now());
}

/** Fil complet, actions des modules privés comprises. */
export async function todayAsync(now = new Date()): Promise<TodayItem[]> {
  const base = today(now);
  const extra: TodayItem[] = [];
  for (const p of db.prepare("SELECT id FROM projects").all() as Row[]) for (const m of activeModules(p.id)) {
    if (!m.actions) continue;
    for (const a of await m.actions(p.id)) extra.push({ key: a.key, kind: "action", tone: "info", project_id: a.project_id, text: a.text, metric: a.metric, to: a.to });
  }
  const ignored = new Set((db.prepare("SELECT key FROM today_items WHERE state = 'ignored' OR until >= ?").all(localDay(now)) as Row[]).map((r) => r.key));
  return [...base, ...extra.filter((i) => !ignored.has(i.key))];
}

const STATES = ["done", "snoozed", "ignored"] as const;
export function registerToday(app: Hono) {
  app.get("/api/today", async (c) => {
    const agent = (c as any).get("agent");
    const items = await todayAsync();
    const ids = agent ? visibleProjectIds(agent) : null;
    return c.json(ids ? items.filter((i) => i.project_id && ids.has(i.project_id)) : items);
  });
  app.post("/api/today/:key", async (c) => {
    if (viewerOf(c) === "anon") return c.json({ error: "Connexion requise" }, 403);
    const b = await c.req.json().catch(() => ({})) as Row;
    if (!STATES.includes(b.state)) return c.json({ error: "État attendu : done, snoozed ou ignored" }, 400);
    setTodayState(c.req.param("key"), b.state);
    return c.json({ ok: true });
  });
}

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
export function registerTodayTools(server: McpServer, readOnly: boolean) {
  server.registerTool("today", { description: "Le fil « Aujourd'hui » : alertes, actions proposées par les modules (mots-clés à faire monter, relances), jalons à 7 jours, objectifs en retard." },
    async () => json(await todayAsync()));
  if (readOnly) return;
  server.registerTool("today_update", {
    description: "Marque un élément du fil : done (fait, revient demain si la situation demeure), snoozed (plus tard, revient demain) ou ignored (ne revient plus).",
    inputSchema: z.object({ key: z.string(), state: z.enum(STATES) }),
  }, async ({ key, state }) => { setTodayState(key, state); return json({ ok: true }); });
}
