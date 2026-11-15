// A1 : audit technique sur un faux site servi par un « fetcher » de test (aucun réseau).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db.ts";
import { auditReport, crawl, findIssues, runAudit, type Fetcher } from "./audit.ts";

const SITE = { id: "site-audit", domain: "audit.test" };
const page = (title: string, body: string, head = "") => `<html><head><title>${title}</title>${head}</head><body>${body}</body></html>`;
const long = "mot ".repeat(300);
const SITEMAP = `<urlset><url><loc>https://audit.test/</loc></url><url><loc>https://audit.test/orpheline</loc></url></urlset>`;
const PAGES: Record<string, { status?: number; body?: string; ct?: string; redirect?: string; ms?: number }> = {
  "/robots.txt": { body: "User-agent: *\nDisallow: /prive\nSitemap: https://audit.test/sitemap.xml", ct: "text/plain" },
  "/sitemap.xml": { body: SITEMAP, ct: "application/xml" },
  "/": { body: page("Accueil du site d'audit, une page de test complète", `<h1>Accueil</h1><a href="/a">A</a><a href="/b">B</a><a href="/ancienne">Ancienne</a><a href="/absente">Absente</a><a href="/prive/x">Privé</a><a href="https://ailleurs.test/">Ailleurs</a><p>${long}</p>`, '<meta name="description" content="Une description suffisamment longue pour passer le contrôle de longueur minimale.">') },
  "/a": { body: page("Titre partagé entre deux pages du site", `<h1>A</h1><h1>A bis</h1><img src="x.png"><p>${long}</p>`), ms: 2000 },
  "/b": { body: page("Titre partagé entre deux pages du site", `<h1>B</h1><p>court</p>`, '<meta name="robots" content="noindex"><meta name="description" content="Une description suffisamment longue pour passer le contrôle de longueur minimale.">') },
  "/ancienne": { redirect: "/b" },
  "/absente": { status: 404, body: "introuvable" },
  "/orpheline": { body: page("Titre partagé entre deux pages du site", `<h1>O</h1><p>${long}</p>`, '<meta name="description" content="Une description suffisamment longue pour passer le contrôle de longueur minimale.">') },
};
const fetcher: Fetcher = async (u) => {
  const url = new URL(u);
  const p = PAGES[url.pathname] ?? { status: 404, body: "" };
  if (p.redirect) { const final = new URL(p.redirect, url).toString(); const r = PAGES[p.redirect]!; return { status: 200, url: final, headers: { "content-type": "text/html" }, body: r.body!, ms: 50, redirects: [u] }; }
  return { status: p.status ?? 200, url: u, headers: { "content-type": p.ct ?? "text/html" }, body: p.body ?? "", ms: p.ms ?? 50, redirects: [] };
};

beforeEach(() => {
  db.exec("DELETE FROM audit_runs; DELETE FROM gsc_rows; DELETE FROM sites");
  db.prepare("INSERT INTO sites (id, domain, name, created_at) VALUES (?, ?, ?, ?)").run(SITE.id, SITE.domain, SITE.domain, Date.now());
});

test("parcours : liens internes suivis, autre domaine ignoré, robots.txt respecté, sitemap ajouté", async () => {
  const c = await crawl(SITE, { fetcher });
  const urls = c.pages.map((p) => p.url).sort();
  assert.ok(urls.includes("https://audit.test/a") && urls.includes("https://audit.test/orpheline"));
  assert.ok(!urls.some((u) => u.includes("ailleurs.test")), "jamais hors du domaine");
  assert.ok(!urls.some((u) => u.includes("/prive")), "page bloquée par robots.txt non visitée");
  assert.deepEqual(c.blocked, ["https://audit.test/prive/x"]);
});

test("problèmes relevés : erreur, redirection, doublons, noindex, H1, lenteur, alt, orpheline, bloquée", async () => {
  const issues = findIssues(await crawl(SITE, { fetcher }));
  const of = (type: string) => issues.filter((i) => i.type === type).map((i) => new URL(i.url).pathname).sort();
  assert.deepEqual(of("http_error"), ["/absente"]);
  assert.deepEqual(of("redirect_link"), ["/ancienne"]);
  assert.deepEqual(of("duplicate_title"), ["/a", "/orpheline"], "la page en noindex (même titre) n'entre pas dans les doublons");
  assert.deepEqual(of("noindex_linked"), ["/b"]);
  assert.deepEqual(of("multiple_h1"), ["/a"]);
  assert.deepEqual(of("slow"), ["/a"]);
  assert.deepEqual(of("images_alt"), ["/a"]);
  assert.deepEqual(of("missing_description"), ["/a"]);
  assert.deepEqual(of("orphan"), ["/orpheline"]);
  assert.deepEqual(of("blocked_robots"), ["/prive/x"]);
  assert.match(issues.find((i) => i.type === "http_error")!.detail!, /404 · liée depuis 1 page/);
});

test("rapport : enregistré, regroupé, classé par gravité puis par trafic Google ; un seul audit à la fois", async () => {
  db.prepare("INSERT INTO gsc_rows (site_id, day, query, page, clicks, impressions, position) VALUES (?, date('now', '-2 day'), '', ?, 80, 900, 4)").run(SITE.id, "https://audit.test/a");
  const { done } = await runAudit(SITE, { fetcher });
  await assert.rejects(runAudit(SITE, { fetcher }), /déjà en cours/);
  await done;
  const r = auditReport(SITE.id);
  assert.equal(r.run!.state, "done");
  assert.ok(r.run!.pages >= 5);
  assert.equal(r.groups[0].type, "http_error", "les erreurs d'abord");
  const warn = r.groups.filter((g) => g.severity === "warn");
  assert.ok(warn.findIndex((g) => g.type === "slow") < warn.findIndex((g) => g.type === "orphan"), "à gravité égale, la page qui a du trafic passe devant");
  assert.equal(r.groups.find((g) => g.type === "slow")!.clicks, 80);
  for (const g of r.groups) assert.ok(g.label && g.advice, g.type);
});
