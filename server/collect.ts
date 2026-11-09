import { createHash } from "node:crypto";
import { db, type Site, localDay } from "./db.ts";

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
  if (isBot(ua) || typeof hit.site !== "string" || typeof hit.url !== "string") return false;
  const site = findSite.get(hit.site, hit.site) as Site | undefined;
  if (!site) return false;
  let url: URL;
  try { url = new URL(hit.url); } catch { return false; }
  // Ne compte que le domaine déclaré (et ses sous-domaines) : évite les données polluées par des tiers
  const host = url.hostname.replace(/^www\./, "");
  if (host !== site.domain && !host.endsWith("." + site.domain) && host !== "localhost") return false;

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
  return true;
}
