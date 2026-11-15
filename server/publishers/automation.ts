// Automatisations de publication (plan D4, D5, D8, D10) : publications récurrentes, flux RSS, meilleurs créneaux, webhooks sortants.
// Tout passe par la file existante (états, idempotence, approbations) ; rien n'est publié en dehors d'elle.
import type { Hono } from "hono";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { db } from "../db.ts";
import { migrate } from "../migrations.ts";
import { registerJob } from "../jobs.ts";
import { isAdmin } from "../admin.ts";
import { savePublication } from "../business.ts";
import { safeGet, safeSend } from "../safe-fetch.ts";
import { getPublication, onPublicationEvent, queuePublication } from "./queue.ts";
import { mediaDir, mediaOf } from "./media.ts";
import { createBatch } from "./batch.ts";
import "./stats.ts"; // table post_stats, lue par bestSlots

type Row = Record<string, any>;
const DAY = 86_400_000;

migrate("2026-11-16-automatisations", `
ALTER TABLE publications ADD COLUMN repeat_days INTEGER;
ALTER TABLE publications ADD COLUMN repeat_child TEXT;
CREATE TABLE rss_feeds (id TEXT PRIMARY KEY, url TEXT NOT NULL, accounts TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'draft', template TEXT NOT NULL,
  seen TEXT NOT NULL DEFAULT '[]', checked_at INTEGER, error TEXT, created_at INTEGER NOT NULL);
CREATE TABLE webhooks (id TEXT PRIMARY KEY, url TEXT NOT NULL, secret TEXT NOT NULL, events TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
  last_status INTEGER, last_error TEXT, last_at INTEGER, created_at INTEGER NOT NULL);`);

// ── D4 : publications récurrentes ──
/** Répéter une publication tous les N jours (0 ou null : plus de répétition). */
export function setRepeat(id: string, days: number | null) {
  if (!getPublication(id)) throw new Error("Publication introuvable");
  const d = days && days > 0 ? Math.min(Math.max(Math.round(days), 1), 365) : null;
  db.prepare("UPDATE publications SET repeat_days = ? WHERE id = ?").run(d, id);
  return getPublication(id);
}

/** Une publication répétée et publiée donne sa suivante, programmée N jours plus tard (même texte, même compte, mêmes médias). */
export async function scheduleRepeats(now = Date.now()) {
  const due = db.prepare("SELECT * FROM publications WHERE repeat_days IS NOT NULL AND state = 'published' AND repeat_child IS NULL").all() as Row[];
  let n = 0;
  for (const p of due) {
    const at = Number(p.published_at ?? p.updated_at ?? now) + Number(p.repeat_days) * DAY;
    const day = new Date(at).toISOString().slice(0, 10);
    const child = savePublication(null, { title: p.title, day, project: p.project, network: p.network, text: p.text, account_id: p.account_id, visible: p.visible }) as Row;
    db.prepare("UPDATE publications SET repeat_days = ?, group_id = ? WHERE id = ?").run(p.repeat_days, p.group_id ?? null, child.id);
    for (const m of mediaOf(String(p.id)) as Row[]) {
      const dir = join(mediaDir(), child.id); mkdirSync(dir, { recursive: true });
      const id = randomUUID(), path = join(dir, `${id}-${m.name}`.replace(/[^\w.-]/g, "_"));
      copyFileSync(m.path, path);
      db.prepare("INSERT INTO pub_media (id, publication_id, name, mime, size, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, child.id, m.name, m.mime, m.size, path, now);
    }
    db.prepare("UPDATE publications SET repeat_child = ? WHERE id = ?").run(child.id, p.id);
    try { await queuePublication(child.id, { at: Math.max(at, now + 60_000) }, now); n++; } catch (e) { db.prepare("UPDATE publications SET notes = ? WHERE id = ?").run(`Répétition non programmée : ${(e as Error).message}`, child.id); }
  }
  return n;
}

// ── D5 : publication depuis un flux RSS ──
export function parseFeed(xml: string): { guid: string; title: string; link: string }[] {
  const text = (s: string | undefined) => (s ?? "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
  const items = [...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].map((m) => m[0]);
  return items.map((it) => {
    const link = text(/<link>([\s\S]*?)<\/link>/i.exec(it)?.[1]) || (/<link\b[^>]*href=["']([^"']+)["']/i.exec(it)?.[1] ?? "");
    const guid = text(/<(?:guid|id)\b[^>]*>([\s\S]*?)<\/(?:guid|id)>/i.exec(it)?.[1]) || link;
    return { guid, title: text(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(it)?.[1]), link };
  }).filter((x) => x.guid && x.title);
}

export const fillTemplate = (tpl: string, item: { title: string; link: string }) => tpl.replace(/\{titre\}|\{title\}/g, item.title).replace(/\{lien\}|\{link\}/g, item.link).trim();

export function addFeed(input: { url?: string; accounts?: string[]; mode?: string; template?: string }) {
  const url = String(input.url ?? "").trim();
  if (!/^https?:\/\//i.test(url)) throw new Error("Adresse du flux (http ou https) requise");
  const accounts = (input.accounts ?? []).map(String).filter(Boolean);
  if (!accounts.length) throw new Error("Choisissez au moins un compte");
  for (const a of accounts) if (!db.prepare("SELECT 1 FROM pub_accounts WHERE id = ?").get(a)) throw new Error("Compte de publication introuvable");
  const id = randomUUID();
  db.prepare("INSERT INTO rss_feeds (id, url, accounts, mode, template, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, url, JSON.stringify(accounts), input.mode === "now" ? "now" : "draft", String(input.template || "{titre} {lien}").slice(0, 1000), Date.now());
  return db.prepare("SELECT * FROM rss_feeds WHERE id = ?").get(id);
}

/** Lit un flux : au premier passage, les articles existants sont seulement mémorisés (pas de rafale). */
export async function checkFeed(feed: Row, fetchFeed: (url: string) => Promise<string> = async (u) => { const r = await safeGet(u, { maxBytes: 3_000_000 }); if (r.status !== 200) throw new Error(`flux introuvable (${r.status})`); return r.body; }) {
  const seen = new Set<string>(JSON.parse(feed.seen));
  const first = !feed.checked_at;
  try {
    const items = parseFeed(await fetchFeed(feed.url));
    const fresh = first ? [] : items.filter((i) => !seen.has(i.guid)).slice(0, 5).reverse();
    for (const it of fresh) {
      const text = fillTemplate(feed.template, it);
      await createBatch({ title: it.title.slice(0, 200), day: new Date().toISOString().slice(0, 10), items: (JSON.parse(feed.accounts) as string[]).map((a) => ({ account_id: a, text })), when: feed.mode === "now" ? "now" : null });
    }
    for (const i of items) seen.add(i.guid);
    db.prepare("UPDATE rss_feeds SET seen = ?, checked_at = ?, error = NULL WHERE id = ?").run(JSON.stringify([...seen].slice(-500)), Date.now(), feed.id);
    return { created: fresh.length, first };
  } catch (e) {
    db.prepare("UPDATE rss_feeds SET checked_at = ?, error = ? WHERE id = ?").run(Date.now(), (e as Error).message.slice(0, 300), feed.id);
    return { created: 0, error: (e as Error).message };
  }
}

// ── D8 : meilleurs créneaux ──
/** Créneaux (jour, heure) où vos publications passées ont le plus d'engagement ; rien sous 5 publications mesurées. */
export function bestSlots(o: { account?: string; network?: string } = {}) {
  const rows = db.prepare(`SELECT p.published_at AS at, COALESCE(s.likes, 0) + COALESCE(s.comments, 0) + COALESCE(s.shares, 0) AS e
    FROM publications p JOIN post_stats s ON s.publication_id = p.id
    WHERE p.published_at IS NOT NULL ${o.account ? "AND p.account_id = ?" : ""} ${o.network ? "AND p.network = ?" : ""}`).all(...[o.account, o.network].filter(Boolean) as string[]) as Row[];
  if (rows.length < 5) return { enough: false, measured: rows.length, slots: [] as { weekday: number; hour: number; engagement: number; posts: number }[] };
  const by = new Map<string, { weekday: number; hour: number; sum: number; n: number }>();
  for (const r of rows) {
    const d = new Date(Number(r.at)), key = `${d.getDay()}-${d.getHours()}`;
    const cur = by.get(key) ?? { weekday: d.getDay(), hour: d.getHours(), sum: 0, n: 0 };
    cur.sum += Number(r.e); cur.n++; by.set(key, cur);
  }
  const slots = [...by.values()].map((x) => ({ weekday: x.weekday, hour: x.hour, engagement: Math.round(x.sum / x.n), posts: x.n }))
    .sort((a, b) => b.engagement - a.engagement || b.posts - a.posts).slice(0, 3);
  return { enough: true, measured: rows.length, slots };
}

// ── D10 : webhooks sortants ──
export const WEBHOOK_EVENTS = ["published", "failed", "to_verify", "needs_action", "threshold"] as const;

export function addWebhook(input: { url?: string; events?: string[] }) {
  const url = String(input.url ?? "").trim();
  if (!/^https:\/\//i.test(url)) throw new Error("Adresse https requise");
  const events = (input.events?.length ? input.events : [...WEBHOOK_EVENTS]).filter((e) => (WEBHOOK_EVENTS as readonly string[]).includes(e));
  const id = randomUUID(), secret = randomBytes(24).toString("hex");
  db.prepare("INSERT INTO webhooks (id, url, secret, events, created_at) VALUES (?, ?, ?, ?, ?)").run(id, url, secret, JSON.stringify(events), Date.now());
  return { id, url, events, secret };   // le secret n'est montré qu'ici
}

export const signBody = (secret: string, body: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

type Sender = (url: string, body: string, headers: Record<string, string>) => Promise<number>;
let send: Sender = async (url, body, headers) => (await safeSend(url, { body, headers, timeoutMs: 8000 })).status;
export const setWebhookSender = (fn: Sender) => { send = fn; };

/** Envoie l'événement aux webhooks abonnés ; chaque appel est signé (HMAC-SHA256 du corps). */
export async function deliver(event: string, payload: Row) {
  const hooks = (db.prepare("SELECT * FROM webhooks WHERE active = 1").all() as Row[]).filter((h) => (JSON.parse(h.events) as string[]).includes(event));
  for (const h of hooks) {
    const body = JSON.stringify({ event, at: new Date().toISOString(), publication: payload });
    try {
      const status = await send(h.url, body, { "content-type": "application/json", "x-searchtide-event": event, "x-searchtide-signature": signBody(h.secret, body) });
      db.prepare("UPDATE webhooks SET last_status = ?, last_error = ?, last_at = ? WHERE id = ?").run(status, status >= 400 ? `réponse ${status}` : null, Date.now(), h.id);
    } catch (e) { db.prepare("UPDATE webhooks SET last_status = NULL, last_error = ?, last_at = ? WHERE id = ?").run((e as Error).message.slice(0, 200), Date.now(), h.id); }
  }
}

onPublicationEvent((e) => {
  if (!(WEBHOOK_EVENTS as readonly string[]).includes(e.state)) return;
  const p = getPublication(e.id);
  void deliver(e.state, { id: e.id, title: p?.title, network: p?.network, project: p?.project, url: e.url ?? p?.evidence_url ?? null, detail: e.detail ?? null });
});

export function registerAutomation(app: Hono) {
  const admin = (c: any) => isAdmin(c) ? null : c.json({ error: "Réservé à l'administrateur" }, 403);
  const wrap = (fn: (c: any) => Promise<Response> | Response) => async (c: any) => { const d = admin(c); if (d) return d; try { return await fn(c); } catch (e) { return c.json({ error: (e as Error).message }, 400); } };
  app.post("/api/publications/:id/repeat", wrap(async (c) => c.json(setRepeat(c.req.param("id"), Number((await c.req.json().catch(() => ({}))).days) || null))));
  app.get("/api/publications/best-slots", wrap((c) => c.json(bestSlots({ account: c.req.query("account") || undefined, network: c.req.query("network") || undefined }))));
  app.get("/api/rss-feeds", wrap((c) => c.json(db.prepare("SELECT id, url, accounts, mode, template, checked_at, error FROM rss_feeds ORDER BY created_at").all())));
  app.post("/api/rss-feeds", wrap(async (c) => { const f = addFeed(await c.req.json().catch(() => ({}))) as Row; await checkFeed(f); return c.json(f, 201); }));
  app.delete("/api/rss-feeds/:id", wrap((c) => c.json({ ok: db.prepare("DELETE FROM rss_feeds WHERE id = ?").run(c.req.param("id")).changes > 0 })));
  app.get("/api/webhooks", wrap((c) => c.json(db.prepare("SELECT id, url, events, active, last_status, last_error, last_at FROM webhooks ORDER BY created_at").all())));
  app.post("/api/webhooks", wrap(async (c) => c.json(addWebhook(await c.req.json().catch(() => ({}))), 201)));
  app.post("/api/webhooks/:id/test", wrap(async (c) => { await deliver("test" as any, { id: "test", title: "Événement de test" }); return c.json(db.prepare("SELECT last_status, last_error FROM webhooks WHERE id = ?").get(c.req.param("id"))); }));
  app.delete("/api/webhooks/:id", wrap((c) => c.json({ ok: db.prepare("DELETE FROM webhooks WHERE id = ?").run(c.req.param("id")).changes > 0 })));
  registerJob("publications", { id: "automatisations", every: "1h", run: async () => {
    await scheduleRepeats();
    for (const f of db.prepare("SELECT * FROM rss_feeds").all() as Row[]) await checkFeed(f);
  } });
}
