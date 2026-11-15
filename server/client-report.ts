// Rapport SEO en marque blanche (plan A9) : une page par projet, à votre nom, logo et couleur, partagée par un lien secret
// révocable. Imprimable en PDF depuis le navigateur. Aucun chiffre sans source : une donnée absente est écrite « — ».
import type { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { db, type Site } from "./db.ts";
import { migrate } from "./migrations.ts";
import { isAdmin } from "./admin.ts";
import { lastDays, searchStats, trafficStats, type Range } from "./stats.ts";
import { getProject } from "./projects.ts";
import { trackedKeywords } from "./keywords.ts";
import { auditReport } from "./audit.ts";
import { indexingStatus } from "./indexing.ts";
import { socialStats } from "./publishers/stats.ts";
import { visibilityReport } from "./visibility.ts";
import { locationsReport } from "./gbp-insights.ts";

type Row = Record<string, any>;

migrate("2026-11-17-rapport-client", `
CREATE TABLE report_brand (id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT, logo TEXT, color TEXT, footer TEXT);
CREATE TABLE report_shares (token TEXT PRIMARY KEY, project_id TEXT NOT NULL, days INTEGER NOT NULL, label TEXT, created_at INTEGER NOT NULL, expires_at INTEGER, revoked_at INTEGER, views INTEGER NOT NULL DEFAULT 0);`);

export type Brand = { name: string; logo: string | null; color: string; footer: string };
export function brand(): Brand {
  const r = db.prepare("SELECT * FROM report_brand WHERE id = 1").get() as Row | undefined;
  return { name: r?.name || "Rapport SEO", logo: r?.logo ?? null, color: r?.color || "#ff7a52", footer: r?.footer ?? "" };
}
export function setBrand(input: { name?: unknown; logo?: unknown; color?: unknown; footer?: unknown }) {
  const cur = brand();
  const color = input.color !== undefined ? String(input.color) : cur.color;
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error("Couleur au format #RRGGBB");
  let logo = cur.logo;
  if (input.logo !== undefined) {
    logo = input.logo ? String(input.logo) : null;
    if (logo && !/^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(logo)) throw new Error("Logo : image PNG, JPEG, WebP ou SVG");
    if (logo && logo.length > 400_000) throw new Error("Logo trop lourd : 300 Ko au plus");
  }
  db.prepare(`INSERT INTO report_brand (id, name, logo, color, footer) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, logo = excluded.logo, color = excluded.color, footer = excluded.footer`)
    .run(String(input.name ?? cur.name).slice(0, 80), logo, color, String(input.footer ?? cur.footer).slice(0, 300));
  return brand();
}

/** Données du rapport : indicateurs du projet, puis par site visites, Google, mots-clés suivis, audit, indexation ; réseaux et visibilité IA. */
export function projectReport(projectId: string, days = 28) {
  const r: Range = lastDays(Math.min(Math.max(days, 7), 365));
  const p = getProject(projectId, r);
  if (!p) throw new Error("Projet introuvable");
  const sites = (p.sites as string[]).map((d) => db.prepare("SELECT * FROM sites WHERE domain = ?").get(d) as Site | undefined).filter(Boolean) as Site[];
  return {
    project: { name: p.name as string, url: p.url as string | null }, range: r, generatedAt: new Date().toISOString(),
    indicators: (p.indicators as Row[]).map((i) => ({ label: i.label, value: i.value, previous: i.previous, unit: i.unit })),
    sites: sites.map((s) => {
      const t = trafficStats(s.id, r);
      const g = s.gsc_property ? searchStats(s.id, r, 10) : null;
      const audit = auditReport(s.id);
      const idx = indexingStatus(s.id);
      return {
        domain: s.domain,
        traffic: { visitors: t.totals.visitors, prevVisitors: t.previous.visitors, pageviews: t.totals.pageviews },
        search: g && { clicks: g.totals.clicks, prevClicks: g.previous.clicks, impressions: g.totals.impressions, prevImpressions: g.previous.impressions,
          position: g.totals.position, prevPosition: g.previous.position, queries: (g.queries as Row[]).slice(0, 10).map((q) => ({ query: q.query, clicks: q.clicks, impressions: q.impressions, position: q.position })) },
        keywords: trackedKeywords(s.id, r).map((k) => ({ query: k.query, position: k.position, previous: k.previous.position, clicks: k.clicks })),
        audit: audit.run ? { at: audit.run.finishedAt ?? audit.run.startedAt, pages: audit.run.pages, groups: audit.groups.map((x) => ({ label: x.label, severity: x.severity, count: x.count, advice: x.advice })) } : null,
        indexing: idx.total ? { total: idx.total, indexed: idx.indexed, notIndexed: idx.notIndexed } : null,
      };
    }),
    social: socialStats({ project: projectId, days: Math.min(days, 90) }).accounts.filter((a) => a.followers != null).map((a) => ({ label: a.label, network: a.network, followers: a.followers, before: a.followersBefore })),
    local: locationsReport({ project: String(p.id), days: Math.min(Math.max(days, 7), 90) }).filter((l) => l.rating != null || l.actions).map((l) => ({ label: l.label, rating: l.rating, total: l.total, actions: l.actions, previous: l.previous })),
    visibility: visibilityReport(String(p.id)).models.filter((m) => m.last).map((m) => ({ label: m.label, share: m.last!.share, week: m.last!.week })),
  };
}

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const nf = (v: unknown, d = 0) => v == null || !Number.isFinite(Number(v)) ? "—" : Number(v).toLocaleString("fr-FR", { maximumFractionDigits: d });
const dfr = (iso: string) => new Date(iso + "T12:00:00Z").toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
/** Évolution écrite : flèche, signe et pourcentage ; pour une position, « en hausse » = plus petite. */
function delta(now: unknown, before: unknown, lowerIsBetter = false) {
  const a = Number(now), b = Number(before);
  if (now == null || before == null || !Number.isFinite(a) || !Number.isFinite(b) || b === 0) return "";
  const pct = lowerIsBetter ? b - a : ((a - b) / Math.abs(b)) * 100;
  if (Math.abs(pct) < (lowerIsBetter ? 0.1 : 0.5)) return `<span class="d">stable</span>`;
  const good = pct > 0;
  return `<span class="d ${good ? "up" : "down"}">${good ? "▲ +" : "▼ −"}${nf(Math.abs(pct), lowerIsBetter ? 1 : 0)}${lowerIsBetter ? " pl." : " %"}</span>`;
}

export function renderReport(data: ReturnType<typeof projectReport>, b: Brand) {
  const kpi = (label: string, value: string, d = "") => `<div class="kpi"><div class="l">${esc(label)}</div><div class="v">${value}</div>${d}</div>`;
  const section = (title: string, body: string) => body ? `<section><h2>${esc(title)}</h2>${body}</section>` : "";
  const sites = data.sites.map((s) => `
    <section class="site"><h2>${esc(s.domain)}</h2>
      <div class="grid">
        ${kpi("Visiteurs", nf(s.traffic.visitors), delta(s.traffic.visitors, s.traffic.prevVisitors))}
        ${kpi("Pages vues", nf(s.traffic.pageviews))}
        ${s.search ? kpi("Clics Google", nf(s.search.clicks), delta(s.search.clicks, s.search.prevClicks)) + kpi("Impressions Google", nf(s.search.impressions), delta(s.search.impressions, s.search.prevImpressions)) + kpi("Position moyenne", nf(s.search.position, 1), delta(s.search.position, s.search.prevPosition, true)) : kpi("Google", "—", '<span class="d">Search Console non reliée</span>')}
      </div>
      ${s.search?.queries.length ? `<h3>Recherches qui amènent des visites</h3><table><thead><tr><th>Recherche</th><th>Clics</th><th>Impressions</th><th>Position</th></tr></thead><tbody>${s.search.queries.map((q) => `<tr><td>${esc(q.query)}</td><td>${nf(q.clicks)}</td><td>${nf(q.impressions)}</td><td>${nf(q.position, 1)}</td></tr>`).join("")}</tbody></table>` : ""}
      ${s.keywords.length ? `<h3>Mots-clés suivis</h3><table><thead><tr><th>Mot-clé</th><th>Position</th><th>Évolution</th><th>Clics</th></tr></thead><tbody>${s.keywords.map((k) => `<tr><td>${esc(k.query)}</td><td>${nf(k.position, 1)}</td><td>${delta(k.position, k.previous, true) || "—"}</td><td>${nf(k.clicks)}</td></tr>`).join("")}</tbody></table>` : ""}
      ${s.audit ? `<h3>Santé technique <span class="muted">(audit du ${new Date(s.audit.at).toLocaleDateString("fr-FR")}, ${nf(s.audit.pages)} pages)</span></h3>${s.audit.groups.length ? `<ul class="issues">${s.audit.groups.map((g) => `<li class="${esc(g.severity)}"><b>${esc(g.label)}</b> · ${nf(g.count)} page${g.count > 1 ? "s" : ""}<br><span class="muted">${esc(g.advice)}</span></li>`).join("")}</ul>` : "<p>Aucun problème relevé.</p>"}` : ""}
      ${s.indexing ? `<p class="muted">Indexation Google : ${nf(s.indexing.indexed)} pages indexées sur ${nf(s.indexing.total)} connues${s.indexing.notIndexed ? `, ${nf(s.indexing.notIndexed)} non indexées` : ""}.</p>` : ""}
    </section>`).join("");
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">
<title>${esc(data.project.name)} · ${esc(b.name)}</title>
<style>
:root{--accent:${b.color};--ink:#16181d;--muted:#5f6672;--rule:#e4e6ea;--good:#13804f;--bad:#c23b3b}
*{box-sizing:border-box}body{margin:0;background:#f6f7f9;color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:960px;margin:0 auto;padding:24px 16px 48px}header{display:flex;align-items:center;gap:16px;border-bottom:3px solid var(--accent);padding-bottom:16px;margin-bottom:24px;flex-wrap:wrap}
header img{max-height:48px;max-width:180px}header .t{flex:1;min-width:200px}h1{margin:0;font-size:26px;font-weight:500}h2{font-size:19px;font-weight:600;margin:0 0 12px}h3{font-size:15px;margin:20px 0 8px}
section{background:#fff;border:1px solid var(--rule);border-radius:12px;padding:20px;margin-bottom:16px;break-inside:avoid-page}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}.kpi{border:1px solid var(--rule);border-radius:10px;padding:12px}
.kpi .l{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}.kpi .v{font-size:26px;font-variant-numeric:tabular-nums;margin-top:2px}
.d{display:block;font-size:12px;color:var(--muted)}.d.up{color:var(--good);font-weight:600}.d.down{color:var(--bad);font-weight:600}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--rule)}th{font-size:12px;color:var(--muted);font-weight:500}td:not(:first-child),th:not(:first-child){text-align:right;font-variant-numeric:tabular-nums}
td .d{display:inline}.muted{color:var(--muted);font-weight:400;font-size:13px}.issues{padding-left:18px}.issues li{margin-bottom:8px}.issues li.bad b{color:var(--bad)}
.print{float:right;border:1px solid var(--rule);background:#fff;border-radius:999px;padding:8px 14px;font:inherit;cursor:pointer}footer{color:var(--muted);font-size:12px;text-align:center;margin-top:24px}
@media print{body{background:#fff}main{padding:0}.print{display:none}section{border-color:#ccc}}
@media (max-width:520px){table{font-size:13px}th,td{padding:5px 4px}}
</style></head><body><main>
<button class="print" type="button" onclick="print()">Imprimer ou enregistrer en PDF</button>
<header>${b.logo ? `<img src="${esc(b.logo)}" alt="${esc(b.name)}">` : ""}<div class="t"><div class="muted">${esc(b.name)}</div><h1>${esc(data.project.name)}</h1>
<div class="muted">Du ${dfr(data.range.from)} au ${dfr(data.range.to)}, comparé à la période précédente</div></div></header>
${section("Indicateurs du projet", data.indicators.length ? `<div class="grid">${data.indicators.map((i) => kpi(i.label, `${nf(i.value, 2)}${i.unit ? ` <small>${esc(i.unit)}</small>` : ""}`, delta(i.value, i.previous))).join("")}</div>` : "")}
${sites}
${section("Fiche Google", data.local.length ? data.local.map((l) => `<h3>${esc(l.label)}</h3><div class="grid">${kpi("Note", l.rating == null ? "—" : `${nf(l.rating, 1)} / 5`, `<span class="d">${nf(l.total)} avis</span>`)}${kpi("Vues de la fiche", nf(l.actions?.views), delta(l.actions?.views, l.previous?.views))}${kpi("Appels", nf(l.actions?.calls), delta(l.actions?.calls, l.previous?.calls))}${kpi("Itinéraires", nf(l.actions?.directions), delta(l.actions?.directions, l.previous?.directions))}${kpi("Clics vers le site", nf(l.actions?.website), delta(l.actions?.website, l.previous?.website))}</div>`).join("") : "")}
${section("Réseaux sociaux", data.social.length ? `<table><thead><tr><th>Compte</th><th>Abonnés</th><th>Évolution</th></tr></thead><tbody>${data.social.map((a) => `<tr><td>${esc(a.label)} <span class="muted">· ${esc(a.network)}</span></td><td>${nf(a.followers)}</td><td>${delta(a.followers, a.before) || "—"}</td></tr>`).join("")}</tbody></table>` : "")}
${section("Visibilité dans les IA", data.visibility.length ? `<div class="grid">${data.visibility.map((v) => kpi(v.label, `${nf(v.share)} %`, `<span class="d">des réponses vous citent (semaine ${esc(v.week.slice(-3))})</span>`)).join("")}</div><p class="muted">Tendance indicative : les réponses des IA varient d'une fois à l'autre.</p>` : "")}
<footer>${esc(b.footer)}${b.footer ? " · " : ""}Rapport généré le ${new Date(data.generatedAt).toLocaleDateString("fr-FR")}</footer>
</main></body></html>`;
}

export function createShare(projectId: string, input: { days?: unknown; expires_days?: unknown; label?: unknown }) {
  const p = db.prepare("SELECT id FROM projects WHERE id = ? OR crm_key = ?").get(projectId, projectId) as Row | undefined;
  if (!p) throw new Error("Projet introuvable");
  const days = [7, 28, 90, 365].includes(Number(input.days)) ? Number(input.days) : 28;
  const exp = Number(input.expires_days) > 0 ? Date.now() + Math.min(Number(input.expires_days), 3650) * 86_400_000 : null;
  const token = randomBytes(24).toString("base64url");
  db.prepare("INSERT INTO report_shares (token, project_id, days, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)").run(token, p.id, days, String(input.label ?? "").slice(0, 80) || null, Date.now(), exp);
  return db.prepare("SELECT * FROM report_shares WHERE token = ?").get(token) as Row;
}

export function registerClientReport(app: Hono) {
  const admin = (c: any) => isAdmin(c) ? null : c.json({ error: "Réservé à l'administrateur" }, 403);
  const wrap = (fn: (c: any) => Promise<Response> | Response) => async (c: any) => { const d = admin(c); if (d) return d; try { return await fn(c); } catch (e) { return c.json({ error: (e as Error).message }, 400); } };
  app.get("/api/report-brand", wrap((c) => c.json(brand())));
  app.put("/api/report-brand", wrap(async (c) => c.json(setBrand(await c.req.json().catch(() => ({}))))));
  app.get("/api/projects/:id/report-shares", wrap((c) => c.json(db.prepare("SELECT * FROM report_shares WHERE project_id = (SELECT id FROM projects WHERE id = ? OR crm_key = ?) ORDER BY created_at DESC").all(c.req.param("id"), c.req.param("id")))));
  app.post("/api/projects/:id/report-shares", wrap(async (c) => c.json(createShare(c.req.param("id"), await c.req.json().catch(() => ({}))), 201)));
  app.delete("/api/report-shares/:token", wrap((c) => c.json({ ok: db.prepare("UPDATE report_shares SET revoked_at = ? WHERE token = ? AND revoked_at IS NULL").run(Date.now(), c.req.param("token")).changes > 0 })));
  app.get("/api/projects/:id/report-preview", wrap((c) => c.html(renderReport(projectReport(c.req.param("id"), Number(c.req.query("days")) || 28), brand()))));

  // Page publique du lien partagé : le secret est le lien ; révoqué ou expiré = introuvable.
  app.get("/r/:token", (c) => {
    const s = db.prepare("SELECT * FROM report_shares WHERE token = ?").get(c.req.param("token")) as Row | undefined;
    const gone = !s || s.revoked_at || (s.expires_at && s.expires_at < Date.now());
    c.header("Cache-Control", "no-store"); c.header("X-Robots-Tag", "noindex, nofollow"); c.header("Referrer-Policy", "no-referrer");
    c.header("Content-Security-Policy", "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    if (gone) return c.html(`<!doctype html><html lang="fr"><meta charset="utf-8"><title>Rapport indisponible</title><body style="font-family:system-ui;padding:40px">Ce rapport n'est plus disponible. Demandez un nouveau lien.</body></html>`, 404);
    db.prepare("UPDATE report_shares SET views = views + 1 WHERE token = ?").run(s.token);
    try { return c.html(renderReport(projectReport(String(s.project_id), Number(s.days)), brand())); }
    catch { return c.html("<!doctype html><title>Rapport indisponible</title><p>Projet introuvable.</p>", 404); }
  });
}
