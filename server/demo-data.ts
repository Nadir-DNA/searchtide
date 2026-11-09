// Données de démonstration (T29) : strictement fictives, domaines réservés (exemple.com), générées au premier
// lancement en DEMO=1. Aucune donnée réelle n'est copiée d'une instance personnelle ; rien n'est écrit si des sites existent.
import { db, localDay } from "./db.ts";
import { record, saveIndicator, saveProject } from "./projects.ts";

const rand = (seed: number) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

const PATHS = ["/", "/tarifs", "/blog/seo-local", "/blog/analytics-sans-cookie", "/contact"];
const CHANNELS = [["direct", 0.35], ["search", 0.75], ["social", 0.85], ["ai", 0.93], ["referral", 1]] as const;   // seuils cumulés
const DEVICES = ["desktop", "mobile", "mobile", "tablet"];

export function seedDemo(now = new Date()) {
  const sites = db.prepare("SELECT COUNT(*) AS n FROM sites").get() as { n: number };
  if (sites.n > 0) return false;   // une instance qui a déjà des données n'est jamais modifiée

  const rnd = rand(20261109);
  const sites_ = [
    { id: "demo-exemple", domain: "exemple.com", name: "Exemple (démo)" },
    { id: "demo-boutique", domain: "exemple-boutique.com", name: "Boutique d'exemple (démo)" },
  ];
  const site = db.prepare("INSERT INTO sites (id, domain, name, gsc_property, created_at) VALUES (?, ?, ?, ?, ?)");
  const evt = db.prepare(`INSERT INTO events (site_id, ts, day, visitor, type, name, path, referrer, channel, country, device, browser, os, lang)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const gsc = db.prepare("INSERT INTO gsc_rows (site_id, day, query, page, clicks, impressions, position) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const start = Date.parse(localDay(now)) - 59 * 86400000;

  for (const s of sites_) site.run(s.id, s.domain, s.name, s.domain === "exemple.com" ? "sc-domain:exemple.com" : null, Date.now());
  db.prepare("INSERT OR REPLACE INTO gsc_syncs (site_id, synced_at, last_day, error) VALUES (?, ?, ?, NULL)")
    .run("demo-exemple", Date.now() - 3600000, localDay(new Date(now.getTime() - 86400000)));
  const queries = [
    ["analytics sans cookie", "/", 8, 410, 6.2],
    ["alternative à google analytics", "/tarifs", 5, 320, 8.7],
    ["search console api", "/blog/seo-local", 3, 180, 11.4],
  ] as const;

  db.exec("BEGIN");
  try {
    for (let d = 0; d < 60; d++) {
      const day = new Date(start + d * 86400000).toISOString().slice(0, 10);
      for (const s of sites_) {
        const base = s.id === "demo-exemple" ? 68 : 26;
        const visitors = Math.round(base * (0.75 + rnd() * 0.5) * (1 + d / 240));   // légère croissance
        for (let v = 0; v < visitors; v++) {
          const visitor = `${s.id}-${day}-${v}`;
          const pages = 1 + Math.floor(rnd() * 3);
          let ch = ""; const r = rnd();
          for (const [name, p] of CHANNELS) { ch = name; if (r <= p) break; }
          for (let p = 0; p < pages; p++) {
            evt.run(s.id, start + d * 86400000 + 8 * 3600000 + v * 60000 + p * 30000, day, visitor, "pageview", null,
              PATHS[Math.floor(rnd() * PATHS.length)],
              ch === "referral" ? "newsletter.exemple.net" : ch === "ai" ? "chatgpt.com" : ch === "search" ? "www.google.com" : null, ch,
              ["FR", "FR", "FR", "DE", "US"][Math.floor(rnd() * 5)], DEVICES[Math.floor(rnd() * 4)],
              ["Chrome", "Firefox", "Safari"][Math.floor(rnd() * 3)], ["macOS", "Windows", "Linux", "iOS", "Android"][Math.floor(rnd() * 5)], "fr");
          }
        }
      }
      // Search Console : lignes par requête + une ligne de totaux du jour (query = page = '') pour les cartes
      let cDay = 0, iDay = 0, pDay = 0;
      for (const [q, page, clicks, impressions, pos] of queries) {
        const c = Math.round(clicks * (0.7 + rnd() * 0.6)), i = Math.round(impressions * (0.8 + rnd() * 0.4)), p = Number((pos + (rnd() - 0.5)).toFixed(1));
        gsc.run("demo-exemple", day, q, page, c, i, p);
        cDay += c; iDay += i; pDay += p;
      }
      gsc.run("demo-exemple", day, "", "", cDay, iDay, Number((pDay / queries.length).toFixed(1)));
    }

    const a = saveProject(null, { name: "Site d'exemple", color: "#2f7d6d", url: "https://exemple.com", sites: ["exemple.com"] })!;
    const b = saveProject(null, { name: "Boutique d'exemple", color: "#b4552d", url: "https://exemple-boutique.com", sites: ["exemple-boutique.com"] })!;
    const contacts = saveIndicator(null, a.id, { label: "Nouveaux contacts", mode: "daily", source: "manual", unit: null, config: {} })!;
    const sales = saveIndicator(null, b.id, { label: "Ventes", mode: "total", source: "manual", unit: "€", config: {} })!;
    for (let d = 0; d < 60; d++) {
      const day = new Date(start + d * 86400000).toISOString().slice(0, 10);
      record(contacts.id, day, Math.round(1 + rnd() * 5));
      record(sales.id, day, Math.round(120 + rnd() * 260));
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return true;
}
