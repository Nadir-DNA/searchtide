import { createHash } from "node:crypto";
import { db, type Site, localDay } from "./db.ts";
import { migrate } from "./migrations.ts";

// 1.1 / A1 : dernière visite acceptée, pour dire dans Installation si le script fonctionne.
export const LAST_HIT_MIGRATION = `ALTER TABLE sites ADD COLUMN last_hit INTEGER;
UPDATE sites SET last_hit = (SELECT MAX(ts) FROM events WHERE events.site_id = sites.id);`;
migrate("2026-11-10-derniere-visite", LAST_HIT_MIGRATION);

// Remplissage pour les bases déjà migrées sans la valeur initiale, et index du MAX(ts) par site.
export const LAST_HIT_FILL_MIGRATION = `UPDATE sites SET last_hit = (SELECT MAX(ts) FROM events WHERE events.site_id = sites.id)
  WHERE last_hit IS NULL OR last_hit < COALESCE((SELECT MAX(ts) FROM events WHERE events.site_id = sites.id), 0);
CREATE INDEX IF NOT EXISTS events_site_ts ON events(site_id, ts);`;
migrate("2026-11-11-derniere-visite-remplissage", LAST_HIT_FILL_MIGRATION);

const LAST_HIT_EVERY = 30_000;              // une écriture au plus toutes les 30 s par site
const lastHitWrites = new Map<string, number>();

// D3 : visites refusées, comptées en mémoire (aucune IP, aucun user-agent), remises à zéro au redémarrage.
const MAX_SITES = 50;
const refused = new Map<string, Record<string, number>>();
export const REFUSAL_REASONS = ["domaine inconnu", "robot ou outil", "hôte différent", "requête invalide", "trop de visites"] as const;
export type RefusalReason = typeof REFUSAL_REASONS[number];

// F3 : limite en mémoire par site ET par IP (burst généreux), pour ne pas perdre un pic légitime.
const BURST = 120;
const PER_SECOND = 20;
// Seaux séparés : vider les IP ne doit jamais réinitialiser la limite par site.
const siteBuckets = new Map<string, { tokens: number; at: number }>();
const ipBuckets = new Map<string, { tokens: number; at: number }>();
function underLimit(buckets: Map<string, { tokens: number; at: number }>, key: string, now: number, cap: number) {
  if (!buckets.has(key) && buckets.size >= cap) {
    const oldest = buckets.keys().next().value;
    if (oldest !== undefined) buckets.delete(oldest);
  }
  const b = buckets.get(key) ?? { tokens: BURST, at: now };
  b.tokens = Math.min(BURST, b.tokens + ((now - b.at) / 1000) * PER_SECOND);
  b.at = now;
  const ok = b.tokens >= 1;
  if (ok) b.tokens -= 1;
  buckets.set(key, b);
  return ok;
}

function noteRefusal(key: string, reason: RefusalReason) {
  if (!refused.has(key)) {
    if (refused.size >= MAX_SITES) {
      const oldest = refused.keys().next().value;
      if (oldest !== undefined) refused.delete(oldest);
    }
    refused.set(key, {});
  }
  const row = refused.get(key)!;
  row[reason] = (row[reason] ?? 0) + 1;
}

/** Compteurs de refus d'un site depuis le dernier redémarrage (clé : id ou domaine). */
export function refusals(siteId: string, domain: string): Record<string, number> {
  const out: Record<string, number> = { ...(refused.get(siteId) ?? {}) };
  if (domain !== siteId) for (const [reason, n] of Object.entries(refused.get(domain) ?? {})) out[reason] = (out[reason] ?? 0) + n;
  return out;
}

const SECRET = process.env.SECRET ?? "dev-secret";

const SEARCH = /(^|\.)(google|bing|duckduckgo|yahoo|ecosia|qwant|yandex|baidu|brave|startpage)\./;
const SOCIAL = /(^|\.)(facebook|instagram|linkedin|lnkd|twitter|x|t|tiktok|youtube|reddit|pinterest|threads|whatsapp|snapchat)\.(com|co|in|net)$/;
const AI = /(^|\.)(chatgpt\.com|chat\.openai\.com|perplexity\.ai|gemini\.google\.com|copilot\.microsoft\.com|claude\.ai|you\.com|phind\.com|meta\.ai|chat\.mistral\.ai|grok\.com|deepseek\.com)$/;
const MAIL = /(^|\.)(mail\.google|outlook\.live|mail\.yahoo|webmail)\./;

export function channelOf(referrer: string | null, utmMedium: string | null): string {
  const m = utmMedium?.toLowerCase();
  if (m && /cpc|ppc|paid|ads/.test(m)) return "paid";
  if (m === "email" || m === "newsletter") return "email";
  if (!referrer) return m === "social" ? "social" : "direct";
  // AI avant search : gemini.google.com serait sinon compté comme Google
  if (AI.test(referrer)) return "ai";
  if (SEARCH.test(referrer)) return "search";
  if (SOCIAL.test(referrer)) return "social";
  if (MAIL.test(referrer)) return "email";
  return "referral";
}

// shortcut: détection par regex, suffisante pour les navigateurs courants ; passer à une lib si besoin de précision
export function parseUA(ua: string) {
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /SamsungBrowser/.test(ua) ? "Samsung"
    : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Autre";
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad|iPod/.test(ua) ? "iOS"
    : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "Autre";
  const device = /iPad|Tablet/.test(ua) ? "tablette" : /Mobi|iPhone|Android/.test(ua) ? "mobile" : "ordinateur";
  return { browser, os, device };
}

export const isBot = (ua: string) => !ua || /bot|crawl|spider|slurp|headless|lighthouse|preview|curl|wget|python|axios/i.test(ua);

const hostOf = (u: string | undefined) => {
  try { return u ? new URL(u).hostname.replace(/^www\./, "") : null; } catch { return null; }
};

const findSite = db.prepare("SELECT * FROM sites WHERE id = ? OR domain = ?");
const insert = db.prepare(`INSERT INTO events (site_id, ts, day, visitor, type, name, path, referrer, channel,
  utm_source, utm_medium, utm_campaign, country, device, browser, os, lang)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

export type Hit = { site: string; url: string; referrer?: string; name?: string; lang?: string };

/** Enregistre une page vue ou un événement. Retourne false si ignoré. */
export function collect(hit: Hit, ip: string, ua: string, country: string | null, now = Date.now()): boolean {
  const key = typeof hit?.site === "string" ? hit.site.slice(0, 200) : "";
  if (isBot(ua) || typeof hit?.site !== "string" || typeof hit?.url !== "string") {
    noteRefusal(key || "inconnu", "robot ou outil"); return false;
  }
  const site = findSite.get(hit.site, hit.site) as Site | undefined;
  if (!site) { noteRefusal(key, "domaine inconnu"); return false; }
  // F3 : seuils par site et par IP ; la réponse HTTP reste 202 (aucun indice pour l'appelant).
  if (!underLimit(siteBuckets, site.id, now, 500) || !underLimit(ipBuckets, ip.slice(0, 60), now, 2_000)) { noteRefusal(site.id, "trop de visites"); return false; }
  let url: URL;
  try { url = new URL(hit.url); } catch { noteRefusal(site.id, "requête invalide"); return false; }
  // Ne compte que le domaine déclaré (et ses sous-domaines) : évite les données polluées par des tiers
  const host = url.hostname.replace(/^www\./, "");
  if (host !== site.domain && !host.endsWith("." + site.domain) && host !== "localhost") { noteRefusal(site.id, "hôte différent"); return false; }

  let referrer = hostOf(hit.referrer);
  if (referrer === host) referrer = null; // navigation interne
  const q = url.searchParams;
  const utm = (k: string) => q.get("utm_" + k)?.slice(0, 100) ?? null;
  const day = localDay(now);
  // Empreinte sans cookie : impossible de suivre quelqu'un d'un jour à l'autre
  const visitor = createHash("sha256").update(`${SECRET}|${day}|${site.id}|${ip}|${ua}`).digest("hex").slice(0, 16);
  const { browser, os, device } = parseUA(ua);

  insert.run(site.id, now, day, visitor, hit.name ? "event" : "pageview", hit.name?.slice(0, 100) ?? null,
    url.pathname.slice(0, 500), referrer, channelOf(referrer, utm("medium")),
    utm("source"), utm("medium"), utm("campaign"), country, device, browser, os, hit.lang?.slice(0, 10) ?? null);
  // last_hit : au plus une écriture toutes les 30 s par site (chaque visite écrit déjà un événement).
  const previous = lastHitWrites.get(site.id) ?? 0;
  if (now - previous >= LAST_HIT_EVERY) {
    db.prepare("UPDATE sites SET last_hit = ? WHERE id = ?").run(now, site.id);
    lastHitWrites.set(site.id, now);
  }
  return true;
}
