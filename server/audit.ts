// Audit technique d'un site (plan A1) : un robot parcourt le site (page d'accueil, liens internes, sitemap),
// relève les problèmes page par page, puis les regroupe et les classe par le trafic Search Console des pages touchées.
// Même domaine uniquement, lecture sûre (aucune adresse interne), nombre de pages et durée bornés.
import type { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { db } from "./db.ts";
import { migrate } from "./migrations.ts";
import { registerJob } from "./jobs.ts";
import { safeGet } from "./safe-fetch.ts";
import { attrs, clean, hostAllowed, robotsAllows, tags } from "./pagecheck.ts";
import { parseSitemap } from "./indexing.ts";

type Row = Record<string, any>;
type Site = { id: string; domain: string };
export type Fetcher = (url: string) => Promise<{ status: number; url: string; headers: Record<string, string>; body: string; ms: number; redirects: string[] }>;

migrate("2026-11-16-audit-technique", `
CREATE TABLE audit_runs (id TEXT PRIMARY KEY, site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE, started_at INTEGER NOT NULL,
  finished_at INTEGER, pages INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, error TEXT);
CREATE TABLE audit_issues (run_id TEXT NOT NULL REFERENCES audit_runs(id) ON DELETE CASCADE, type TEXT NOT NULL, url TEXT NOT NULL, detail TEXT);
CREATE INDEX audit_issues_run ON audit_issues(run_id, type);`);

/** Problèmes reconnus : gravité, libellé, conseil. */
export const ISSUES: Record<string, { severity: "bad" | "warn" | "info"; label: string; advice: string }> = {
  http_error: { severity: "bad", label: "Pages en erreur (4xx, 5xx)", advice: "Corrigez la page ou redirigez-la, et retirez les liens qui y mènent." },
  noindex_linked: { severity: "warn", label: "Pages exclues de l'index (noindex)", advice: "Vérifiez qu'elles doivent vraiment rester hors de Google." },
  blocked_robots: { severity: "warn", label: "Pages bloquées par robots.txt", advice: "Google ne peut pas les explorer : retirez la règle si elles doivent être indexées." },
  missing_title: { severity: "bad", label: "Titre absent", advice: "Chaque page a besoin d'un titre unique avec son mot-clé principal." },
  duplicate_title: { severity: "warn", label: "Titres en double", advice: "Donnez à chaque page un titre qui la distingue des autres." },
  title_length: { severity: "info", label: "Titres trop courts ou trop longs", advice: "Visez 30 à 60 caractères." },
  missing_description: { severity: "warn", label: "Meta description absente", advice: "Un résumé de 70 à 160 caractères donne envie de cliquer." },
  duplicate_description: { severity: "info", label: "Meta descriptions en double", advice: "Écrivez un résumé propre à chaque page." },
  missing_h1: { severity: "warn", label: "H1 absent", advice: "Ajoutez un titre principal qui annonce le sujet." },
  multiple_h1: { severity: "info", label: "Plusieurs H1", advice: "Gardez un seul H1 par page." },
  redirect_link: { severity: "info", label: "Liens internes vers une redirection", advice: "Pointez directement vers l'adresse finale." },
  slow: { severity: "warn", label: "Pages lentes (plus de 1,5 s)", advice: "Allégez la page ou le serveur ; voyez PageSpeed pour le détail." },
  thin: { severity: "info", label: "Contenu léger (moins de 250 mots)", advice: "Développez si la page doit se classer sur une recherche." },
  images_alt: { severity: "info", label: "Images sans texte alternatif", advice: "Décrivez les images utiles (attribut alt)." },
  orphan: { severity: "warn", label: "Pages orphelines (dans le sitemap, sans lien interne)", advice: "Reliez-les depuis d'autres pages pour qu'elles soient trouvées." },
  deep: { severity: "info", label: "Pages à plus de 3 clics de l'accueil", advice: "Rapprochez les pages importantes de l'accueil." },
};

type Page = { url: string; status: number; ms: number; depth: number; title: string; description: string; h1: number; noindex: boolean;
  words: number; noAlt: number; links: string[]; redirectTo?: string };

const norm = (u: string) => { const x = new URL(u); x.hash = ""; if (x.pathname !== "/" && x.pathname.endsWith("/")) x.pathname = x.pathname.slice(0, -1); return x.toString(); };
const SKIP = /\.(jpe?g|png|gif|webp|svg|ico|pdf|zip|mp4|mov|webm|mp3|css|js|xml|txt|woff2?|ttf)(\?|$)/i;

export function extract(html: string, url: string): Omit<Page, "status" | "ms" | "depth"> {
  const page = new URL(url);
  const metas = tags(html, "meta");
  const meta = (k: string) => metas.find((m) => (m.name ?? "").toLowerCase() === k)?.content?.trim() ?? "";
  const links = tags(html, "a").flatMap((a) => {
    if (!a.href || /^(#|mailto:|tel:|javascript:)/i.test(a.href) || (a.rel ?? "").includes("nofollow")) return [];
    try { const u = new URL(a.href, page); return u.hostname === page.hostname && /^https?:$/.test(u.protocol) && !SKIP.test(u.pathname) ? [norm(u.toString())] : []; } catch { return []; }
  });
  const text = clean(html.replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, " "));
  return {
    url, title: clean(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? ""), description: meta("description"),
    h1: (html.match(/<h1\b/gi) ?? []).length, noindex: meta("robots").toLowerCase().includes("noindex"),
    words: text ? text.split(" ").length : 0, noAlt: tags(html, "img").filter((i) => !("alt" in i)).length, links: [...new Set(links)],
  };
}

/** Parcours en largeur depuis l'accueil, plus les adresses du sitemap. */
export async function crawl(site: Site, o: { maxPages?: number; fetcher?: Fetcher; onPage?: (n: number) => void } = {}) {
  const allow = hostAllowed(site.domain);
  const get: Fetcher = o.fetcher ?? ((u) => safeGet(u, { allow: (x) => allow(x.hostname), maxBytes: 3_000_000, timeoutMs: 15_000 }));
  const max = Math.min(o.maxPages ?? 200, 1000);
  const home = norm(`https://${site.domain}/`);
  let robots = "", sitemapUrls: string[] = [];
  try { const r = await get(`https://${site.domain}/robots.txt`); if (r.status === 200) robots = r.body; } catch { /* sans robots.txt */ }
  try {
    const sm = robotsAllows(robots, "/").sitemaps[0] ?? `https://${site.domain}/sitemap.xml`;
    const r = await get(sm);
    if (r.status === 200) {
      const parsed = parseSitemap(r.body);
      const list = parsed.index ? [] : parsed.entries.map((e) => e.loc);
      if (parsed.index) for (const child of parsed.entries.slice(0, 5)) { const c = await get(child.loc).catch(() => null); if (c?.status === 200) list.push(...parseSitemap(c.body).entries.map((e) => e.loc)); }
      sitemapUrls = list.filter((u) => { try { return allow(new URL(u).hostname); } catch { return false; } }).map(norm);
    }
  } catch { /* sans sitemap */ }

  const pages = new Map<string, Page>();
  const linkedFrom = new Map<string, Set<string>>();
  const blocked: string[] = [];
  const queue: { url: string; depth: number }[] = [{ url: home, depth: 0 }, ...sitemapUrls.map((url) => ({ url, depth: 99 }))];
  const seen = new Set<string>();
  while (queue.length && pages.size < max) {
    const { url, depth } = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    const path = new URL(url).pathname + new URL(url).search;
    if (robots && !robotsAllows(robots, path).allowed) { blocked.push(url); continue; }
    let r;
    try { r = await get(url); } catch (e) { pages.set(url, { url, status: 0, ms: 0, depth, title: "", description: "", h1: 0, noindex: false, words: 0, noAlt: 0, links: [] }); continue; }
    const final = norm(r.url);
    const info = /html/i.test(r.headers["content-type"] ?? "text/html") && r.status < 400 ? extract(r.body, r.url) : { url, title: "", description: "", h1: 0, noindex: false, words: 0, noAlt: 0, links: [] };
    const xRobots = (r.headers["x-robots-tag"] ?? "").toLowerCase().includes("noindex");
    pages.set(url, { ...info, url, status: r.status, ms: r.ms, depth, noindex: info.noindex || xRobots, redirectTo: final !== url ? final : undefined });
    for (const l of info.links) {
      if (!linkedFrom.has(l)) linkedFrom.set(l, new Set());
      linkedFrom.get(l)!.add(url);
      if (!seen.has(l)) queue.push({ url: l, depth: depth === 99 ? 99 : depth + 1 });
    }
    o.onPage?.(pages.size);
  }
  // Profondeur réelle : les pages trouvées seulement par le sitemap gardent 99 si aucun lien n'y mène.
  return { pages: [...pages.values()], linkedFrom, sitemapUrls, blocked };
}

/** Problèmes relevés à partir du parcours. */
export function findIssues(c: Awaited<ReturnType<typeof crawl>>) {
  const out: { type: string; url: string; detail?: string }[] = [];
  const add = (type: string, url: string, detail?: string) => out.push({ type, url, detail });
  // Contrôles de contenu : pages finales seulement (une adresse qui redirige n'est pas une page).
  const ok = c.pages.filter((p) => p.status >= 200 && p.status < 300 && !p.redirectTo);
  for (const p of c.pages) {
    if (p.status >= 400 || p.status === 0) add("http_error", p.url, `${p.status || "injoignable"}${c.linkedFrom.get(p.url)?.size ? ` · liée depuis ${c.linkedFrom.get(p.url)!.size} page(s)` : ""}`);
    if (p.redirectTo && c.linkedFrom.get(p.url)?.size) add("redirect_link", p.url, `redirige vers ${p.redirectTo}`);
  }
  for (const p of ok) {
    if (p.noindex) add("noindex_linked", p.url);
    if (!p.title) add("missing_title", p.url); else if (p.title.length < 30 || p.title.length > 60) add("title_length", p.url, `${p.title.length} caractères`);
    if (!p.description) add("missing_description", p.url);
    if (p.h1 === 0) add("missing_h1", p.url); else if (p.h1 > 1) add("multiple_h1", p.url, `${p.h1} H1`);
    if (p.ms > 1500) add("slow", p.url, `${p.ms} ms`);
    if (p.words < 250 && !p.noindex) add("thin", p.url, `${p.words} mots`);
    if (p.noAlt) add("images_alt", p.url, `${p.noAlt} image(s)`);
    if (p.depth > 3 && p.depth !== 99) add("deep", p.url, `${p.depth} clics`);
  }
  for (const [field, type] of [["title", "duplicate_title"], ["description", "duplicate_description"]] as const) {
    const groups = new Map<string, string[]>();
    for (const p of ok) if (p[field] && !p.noindex) groups.set(p[field], [...(groups.get(p[field]) ?? []), p.url]);
    for (const [value, urls] of groups) if (urls.length > 1) for (const u of urls) add(type, u, `« ${value.slice(0, 80)} » sur ${urls.length} pages`);
  }
  for (const u of c.sitemapUrls) if (!c.linkedFrom.get(u)?.size && u !== c.pages[0]?.url) add("orphan", u);
  for (const u of c.blocked) add("blocked_robots", u);
  return out;
}

const running = new Set<string>();

export async function runAudit(site: Site, o: { maxPages?: number; fetcher?: Fetcher } = {}) {
  if (running.has(site.id)) throw new Error("Un audit de ce site est déjà en cours");
  running.add(site.id);
  const id = randomUUID();
  db.prepare("INSERT INTO audit_runs (id, site_id, started_at, state) VALUES (?, ?, ?, 'running')").run(id, site.id, Date.now());
  const done = (async () => {
    try {
      const c = await crawl(site, { ...o, onPage: (n) => db.prepare("UPDATE audit_runs SET pages = ? WHERE id = ?").run(n, id) });
      const issues = findIssues(c);
      db.exec("BEGIN");
      for (const i of issues) db.prepare("INSERT INTO audit_issues (run_id, type, url, detail) VALUES (?, ?, ?, ?)").run(id, i.type, i.url, i.detail ?? null);
      db.prepare("UPDATE audit_runs SET state = 'done', finished_at = ?, pages = ? WHERE id = ?").run(Date.now(), c.pages.length, id);
      db.exec("COMMIT");
      // Garder les 5 derniers audits par site
      db.prepare("DELETE FROM audit_runs WHERE site_id = ? AND id NOT IN (SELECT id FROM audit_runs WHERE site_id = ? ORDER BY started_at DESC LIMIT 5)").run(site.id, site.id);
    } catch (e) {
      if (db.isTransaction) db.exec("ROLLBACK");
      db.prepare("UPDATE audit_runs SET state = 'failed', finished_at = ?, error = ? WHERE id = ?").run(Date.now(), (e as Error).message.slice(0, 300), id);
    } finally { running.delete(site.id); }
  })();
  return { id, done };
}

/** Dernier audit d'un site : problèmes regroupés, classés par gravité puis par trafic Google des pages touchées. */
export function auditReport(siteId: string) {
  const run = db.prepare("SELECT * FROM audit_runs WHERE site_id = ? ORDER BY started_at DESC LIMIT 1").get(siteId) as Row | undefined;
  if (!run) return { run: null, groups: [] };
  const traffic = new Map((db.prepare(`SELECT page, SUM(clicks) AS clicks, SUM(impressions) AS impressions FROM gsc_rows
    WHERE site_id = ? AND query = '' AND page <> '' AND day >= date('now', '-28 day') GROUP BY page`).all(siteId) as Row[]).map((r) => [String(r.page).replace(/\/$/, ""), r]));
  const t = (u: string): { clicks: number; impressions: number } => { const r = traffic.get(u.replace(/\/$/, "")); return { clicks: Number(r?.clicks ?? 0), impressions: Number(r?.impressions ?? 0) }; };
  const rows = db.prepare("SELECT type, url, detail FROM audit_issues WHERE run_id = ?").all(run.id) as Row[];
  const by = new Map<string, Row[]>();
  for (const r of rows) by.set(r.type, [...(by.get(r.type) ?? []), r]);
  const rank = { bad: 0, warn: 1, info: 2 };
  const groups = [...by].map(([type, list]) => {
    const pages = list.map((r) => ({ url: r.url, detail: r.detail, ...t(r.url) })).sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
    return { type, ...ISSUES[type], count: pages.length, clicks: pages.reduce((n, p) => n + p.clicks, 0), pages: pages.slice(0, 50) };
  }).sort((a, b) => rank[a.severity] - rank[b.severity] || b.clicks - a.clicks || b.count - a.count);
  return { run: { id: run.id, state: run.state, pages: run.pages, startedAt: run.started_at, finishedAt: run.finished_at, error: run.error }, groups };
}

export function registerAudit(app: Hono, getSite: (id: string) => Site | undefined) {
  app.get("/api/sites/:id/audit", (c) => {
    const s = getSite(c.req.param("id"));
    return s ? c.json(auditReport(s.id)) : c.json({ error: "Site introuvable" }, 404);
  });
  app.post("/api/sites/:id/audit", async (c) => {
    const s = getSite(c.req.param("id"));
    if (!s) return c.json({ error: "Site introuvable" }, 404);
    const b = await c.req.json().catch(() => ({})) as Row;
    try { const { id } = await runAudit(s, { maxPages: Number(b.max_pages) || 200 }); return c.json({ id, state: "running" }, 202); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
  });
  // Chaque semaine, les sites déjà audités sont repassés.
  registerJob("analytics", { id: "audit-technique", every: "168h", run: async () => {
    const sites = db.prepare("SELECT DISTINCT s.id, s.domain FROM sites s JOIN audit_runs r ON r.site_id = s.id").all() as Site[];
    for (const s of sites) { try { await (await runAudit(s)).done; } catch (e) { console.error(`[audit] ${s.domain} :`, (e as Error).message); } }
  } });
}
