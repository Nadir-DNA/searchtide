// Vérificateur de page (plan A2) : title, meta description, H1, canonical, robots, Open Graph, données structurées,
// hreflang, images sans texte alternatif, liens, robots.txt et sitemap. Lecture seule, domaines des sites suivis uniquement.
import type { Hono } from "hono";
import { safeGet, SafeFetchError } from "./safe-fetch.ts";

export type Check = { id: string; label: string; status: "ok" | "warn" | "bad" | "info"; value: string; advice?: string };
type Attrs = Record<string, string>;

export const decode = (s: string) => s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
export const clean = (s: string) => decode(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

export function attrs(tag: string): Attrs {
  const out: Attrs = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) out[m[1].toLowerCase()] = decode(m[3] ?? m[4] ?? m[5] ?? "");
  return out;
}
export const tags = (html: string, name: string) => [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, "gi"))].map((m) => attrs(m[0]));

/** Analyse HTML seule (testable sans réseau). `url` sert à juger le canonical et les liens internes. */
export function analyzeHtml(html: string, url: string): Check[] {
  const page = new URL(url);
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);
  const metas = tags(html, "meta");
  const meta = (key: string) => metas.find((m) => (m.name ?? m.property ?? "").toLowerCase() === key)?.content?.trim() ?? null;
  const links = tags(html, "link");

  const title = clean(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "");
  add(!title ? { id: "title", label: "Titre (title)", status: "bad", value: "absent", advice: "Ajoutez un titre unique de 30 à 60 caractères avec le mot-clé principal." }
    : { id: "title", label: "Titre (title)", status: title.length < 30 || title.length > 60 ? "warn" : "ok", value: `${title} (${title.length} car.)`,
      advice: title.length < 30 ? "Un peu court : 30 à 60 caractères." : title.length > 60 ? "Risque d'être coupé dans Google : visez 60 caractères au plus." : undefined });

  const desc = meta("description");
  add(!desc ? { id: "description", label: "Meta description", status: "warn", value: "absente", advice: "Ajoutez un résumé de 70 à 160 caractères qui donne envie de cliquer." }
    : { id: "description", label: "Meta description", status: desc.length < 70 || desc.length > 160 ? "warn" : "ok", value: `${desc.slice(0, 200)} (${desc.length} car.)`,
      advice: desc.length < 70 ? "Un peu courte : 70 à 160 caractères." : desc.length > 160 ? "Risque d'être coupée : 160 caractères au plus." : undefined });

  const h1s = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => clean(m[1]));
  add({ id: "h1", label: "Titre principal (H1)", status: h1s.length === 1 ? "ok" : "warn", value: h1s.length ? `${h1s.length} : ${h1s.slice(0, 3).join(" · ")}` : "absent",
    advice: h1s.length === 0 ? "Ajoutez un H1 qui annonce le sujet de la page." : h1s.length > 1 ? "Gardez un seul H1 par page." : undefined });

  const canonical = links.find((l) => (l.rel ?? "").toLowerCase().split(/\s+/).includes("canonical"))?.href;
  if (!canonical) add({ id: "canonical", label: "URL canonique", status: "warn", value: "absente", advice: "Déclarez l'adresse de référence de la page pour éviter les doublons." });
  else {
    const abs = new URL(canonical, page).toString().replace(/\/$/, ""), self = page.toString().replace(/\/$/, "");
    add({ id: "canonical", label: "URL canonique", status: abs === self ? "ok" : "info", value: abs, advice: abs === self ? undefined : "La page désigne une autre adresse comme référence : elle ne sera pas classée elle-même." });
  }

  const robots = (meta("robots") ?? "").toLowerCase();
  add({ id: "robots-meta", label: "Indexation (meta robots)", status: robots.includes("noindex") ? "bad" : "ok", value: robots || "aucune restriction",
    advice: robots.includes("noindex") ? "La page demande à ne pas être indexée : retirez noindex si elle doit apparaître dans Google." : undefined });

  const lang = /<html\b[^>]*\slang\s*=\s*["']?([^"'\s>]+)/i.exec(html)?.[1];
  add({ id: "lang", label: "Langue (lang)", status: lang ? "ok" : "warn", value: lang ?? "absente", advice: lang ? undefined : 'Ajoutez lang="fr" (ou la langue de la page) sur la balise html.' });

  const viewport = meta("viewport");
  add({ id: "viewport", label: "Affichage mobile (viewport)", status: viewport ? "ok" : "bad", value: viewport ?? "absent", advice: viewport ? undefined : "Sans viewport, la page s'affiche mal sur téléphone." });

  const og = ["og:title", "og:description", "og:image"].filter((k) => !meta(k));
  add({ id: "open-graph", label: "Partage sur les réseaux (Open Graph)", status: og.length ? "warn" : "ok", value: og.length ? `manque ${og.join(", ")}` : "titre, description et image présents",
    advice: og.length ? "Ces balises donnent l'aperçu affiché quand la page est partagée." : undefined });

  const types: string[] = [];
  let invalid = 0;
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = (n: any): void => { if (Array.isArray(n)) n.forEach(walk); else if (n && typeof n === "object") { if (n["@type"]) types.push(...[].concat(n["@type"])); if (n["@graph"]) walk(n["@graph"]); } };
      walk(JSON.parse(m[1]));
    } catch { invalid++; }
  }
  add({ id: "schema", label: "Données structurées (Schema)", status: invalid ? "bad" : types.length ? "ok" : "info", value: invalid ? `${invalid} bloc(s) JSON-LD illisible(s)` : types.length ? [...new Set(types)].join(", ") : "aucune",
    advice: invalid ? "Corrigez le JSON : Google ignore un bloc invalide." : types.length ? undefined : "Facultatif, mais utile : organisation, produit, article, FAQ… (générateur ci-dessous)." });

  const hreflang = links.filter((l) => (l.rel ?? "").toLowerCase() === "alternate" && l.hreflang);
  if (hreflang.length) add({ id: "hreflang", label: "Versions linguistiques (hreflang)", status: "info", value: hreflang.map((l) => l.hreflang).join(", ") });

  const imgs = tags(html, "img"), noAlt = imgs.filter((i) => !("alt" in i)).length;
  add({ id: "images-alt", label: "Images sans texte alternatif", status: noAlt ? "warn" : "ok", value: `${noAlt} sur ${imgs.length}`, advice: noAlt ? "Décrivez chaque image utile (attribut alt) : accessibilité et recherche d'images." : undefined });

  const anchors = tags(html, "a").filter((a) => a.href && !/^(#|mailto:|tel:|javascript:)/i.test(a.href));
  const internal = anchors.filter((a) => { try { return new URL(a.href, page).hostname === page.hostname; } catch { return false; } }).length;
  add({ id: "links", label: "Liens", status: internal ? "ok" : "warn", value: `${internal} internes, ${anchors.length - internal} externes`, advice: internal ? undefined : "Reliez cette page aux autres pages du site pour qu'elle soit trouvée." });

  const text = clean(html.replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, " "));
  const words = text ? text.split(" ").length : 0;
  add({ id: "words", label: "Volume de texte", status: words < 250 ? "warn" : "ok", value: `${words} mots`, advice: words < 250 ? "Contenu léger : développez pour répondre complètement à la recherche." : undefined });
  return checks;
}

/** Règles robots.txt (groupe Googlebot, sinon *), correspondance la plus longue, jokers * et $. */
export function robotsAllows(robotsTxt: string, path: string, agent = "googlebot"): { allowed: boolean; sitemaps: string[] } {
  const groups: { agents: string[]; rules: [boolean, string][] }[] = [];
  const sitemaps: string[] = [];
  let cur: { agents: string[]; rules: [boolean, string][] } | null = null, lastWasAgent = false;
  for (const raw of robotsTxt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === "sitemap") { if (val) sitemaps.push(val); continue; }
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase()); lastWasAgent = true; continue;
    }
    lastWasAgent = false;
    if (cur && (key === "allow" || key === "disallow") && val) cur.rules.push([key === "allow", val]);
  }
  const group = groups.find((g) => g.agents.includes(agent)) ?? groups.find((g) => g.agents.includes("*"));
  let best: [boolean, number] = [true, -1];
  for (const [allow, pattern] of group?.rules ?? []) {
    const re = new RegExp("^" + pattern.replace(/[.+?^{}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$|\$$/, "$"));
    if (re.test(path) && (pattern.length > best[1] || (pattern.length === best[1] && allow))) best = [allow, pattern.length];
  }
  return { allowed: best[0], sitemaps };
}

/** Vérifie une page d'un site suivi : la page, robots.txt et le sitemap. */
export async function checkPage(url: string, allowHost: (host: string) => boolean) {
  const allow = (u: URL) => allowHost(u.hostname);
  const res = await safeGet(url, { allow });
  const final = new URL(res.url);
  const checks: Check[] = [
    { id: "status", label: "Réponse du serveur", status: res.status === 200 ? "ok" : "bad", value: `${res.status}${res.redirects.length ? ` après ${res.redirects.length} redirection(s)` : ""}`,
      advice: res.status === 200 ? undefined : "La page doit répondre 200 pour être indexée." },
    { id: "speed", label: "Temps de réponse", status: res.ms > 1500 ? "warn" : "ok", value: `${res.ms} ms · ${Math.round(res.bytes / 1024)} Ko`, advice: res.ms > 1500 ? "Réponse lente : voyez PageSpeed pour le détail." : undefined },
  ];
  const xRobots = (res.headers["x-robots-tag"] ?? "").toLowerCase();
  if (xRobots.includes("noindex")) checks.push({ id: "x-robots", label: "En-tête X-Robots-Tag", status: "bad", value: xRobots, advice: "Le serveur demande à ne pas indexer la page." });
  if (/html/i.test(res.headers["content-type"] ?? "html")) checks.push(...analyzeHtml(res.body, res.url));

  let sitemapUrl: string | null = null;
  try {
    const robots = await safeGet(new URL("/robots.txt", final).toString(), { allow, maxBytes: 512_000, timeoutMs: 8000 });
    if (robots.status === 200) {
      const r = robotsAllows(robots.body, final.pathname + final.search);
      checks.push({ id: "robots-txt", label: "robots.txt", status: r.allowed ? "ok" : "bad", value: r.allowed ? "la page est autorisée" : "la page est bloquée pour Googlebot",
        advice: r.allowed ? undefined : "Retirez la règle Disallow qui couvre cette adresse si elle doit être indexée." });
      sitemapUrl = r.sitemaps[0] ?? null;
    } else checks.push({ id: "robots-txt", label: "robots.txt", status: "info", value: `absent (${robots.status})`, advice: "Facultatif ; il permet d'indiquer l'adresse du sitemap (générateur ci-dessous)." });
  } catch (e) { checks.push({ id: "robots-txt", label: "robots.txt", status: "info", value: `illisible : ${(e as Error).message}` }); }

  try {
    const sm = await safeGet(sitemapUrl ?? new URL("/sitemap.xml", final).toString(), { allow, maxBytes: 5_000_000, timeoutMs: 10_000 });
    if (sm.status === 200 && /<(urlset|sitemapindex)\b/i.test(sm.body)) {
      const locs = [...sm.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => decode(m[1]));
      const index = /<sitemapindex\b/i.test(sm.body);
      const listed = !index && locs.some((l) => l.replace(/\/$/, "") === res.url.replace(/\/$/, ""));
      checks.push({ id: "sitemap", label: "Sitemap", status: index || listed ? "ok" : "warn",
        value: index ? `index de ${locs.length} sitemap(s)` : `${locs.length} adresse(s)${listed ? ", dont cette page" : ", cette page n'y figure pas"}${sm.truncated ? " (lu en partie)" : ""}`,
        advice: index || listed ? undefined : "Ajoutez la page au sitemap pour qu'elle soit découverte plus vite." });
    } else checks.push({ id: "sitemap", label: "Sitemap", status: "warn", value: "introuvable", advice: "Publiez un sitemap.xml et déclarez-le dans robots.txt et dans Search Console." });
  } catch (e) { checks.push({ id: "sitemap", label: "Sitemap", status: "warn", value: `illisible : ${(e as Error).message}` }); }

  const score = { ok: checks.filter((c) => c.status === "ok").length, warn: checks.filter((c) => c.status === "warn").length, bad: checks.filter((c) => c.status === "bad").length };
  return { url: res.url, checkedAt: new Date().toISOString(), score, checks };
}

/** Le domaine d'un site suivi ou l'un de ses sous-domaines. */
export const hostAllowed = (domain: string) => (host: string) => { const h = host.toLowerCase(), d = domain.toLowerCase(); return h === d || h.endsWith("." + d); };

export function pageUrlFor(domain: string, input: string): string {
  const v = String(input ?? "").trim() || "/";
  return v.startsWith("/") ? `https://${domain}${v}` : /^https?:\/\//i.test(v) ? v : `https://${v}`;
}

/** Route REST, sous /api/sites/:id pour hériter de la portée des clés d'agent. */
export function registerPageCheck(app: Hono, getSite: (id: string) => { id: string; domain: string } | undefined) {
  app.get("/api/sites/:id/page-check", async (c) => {
    const s = getSite(c.req.param("id"));
    if (!s) return c.json({ error: "Site introuvable" }, 404);
    const url = pageUrlFor(s.domain, c.req.query("url") ?? "/");
    try {
      if (!hostAllowed(s.domain)(new URL(url).hostname)) return c.json({ error: `Adresse hors du site ${s.domain}` }, 400);
      return c.json(await checkPage(url, hostAllowed(s.domain)));
    } catch (e) {
      const msg = e instanceof SafeFetchError ? e.message : `Page injoignable : ${(e as Error).message}`;
      return c.json({ error: msg }, 400);
    }
  });
}
