// A4 : suivi de mots-clés et diagnostics Search Console, sur des lignes gsc_rows écrites à la main.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { db } from "./db.ts";
import { keywordDrops, keywordSuggestions, normalizeQuery, registerKeywords, seoInsights, trackKeyword, trackedKeywords, expectedCtr } from "./keywords.ts";
import type { Range } from "./stats.ts";

const SITE = "site-mots-cles";
const r: Range = { from: "2026-11-08", to: "2026-11-14" };   // période ; la précédente : 1er au 7 novembre
const row = (day: string, query: string, page: string, clicks: number, impressions: number, position: number) =>
  db.prepare("INSERT INTO gsc_rows (site_id, day, query, page, clicks, impressions, position) VALUES (?, ?, ?, ?, ?, ?, ?)").run(SITE, day, query, page, clicks, impressions, position);

beforeEach(() => {
  db.exec("DELETE FROM gsc_rows; DELETE FROM tracked_keywords; DELETE FROM sites");
  db.prepare("INSERT INTO sites (id, domain, name, created_at) VALUES (?, ?, ?, ?)").run(SITE, "mots-cles.test", "mots-cles.test", Date.now());
});

test("suivi : normalisation, idempotence, retrait, mot-clé vide refusé", () => {
  assert.equal(normalizeQuery("  Analytics   SANS Cookie "), "analytics sans cookie");
  trackKeyword(SITE, "Analytics sans cookie");
  trackKeyword(SITE, "analytics  sans cookie");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM tracked_keywords").get() as { n: number }).n, 1);
  trackKeyword(SITE, "analytics sans cookie", false);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM tracked_keywords").get() as { n: number }).n, 0);
  assert.throws(() => trackKeyword(SITE, "   "), /vide/);
});

test("mot-clé suivi : position pondérée par les impressions, période précédente, courbe et meilleure page", () => {
  row("2026-11-02", "pompe a chaleur", "/a", 2, 100, 8);
  row("2026-11-09", "pompe a chaleur", "/a", 10, 100, 4);
  row("2026-11-09", "pompe a chaleur", "/b", 0, 300, 12);   // (4×100 + 12×300) / 400 = 10
  row("2026-11-10", "pompe a chaleur", "/a", 6, 100, 5);
  trackKeyword(SITE, "pompe a chaleur");
  const [k] = trackedKeywords(SITE, r);
  assert.equal(k.clicks, 16);
  assert.equal(k.impressions, 500);
  assert.equal(k.previous.position, 8);
  assert.equal(k.page, "/a", "la page qui ramène le plus de clics");
  assert.deepEqual(k.series.map((d: any) => [d.day, d.position]), [["2026-11-09", 10], ["2026-11-10", 5]]);
});

test("recul : seulement les mots-clés suivis qui perdent 3 places ou plus, avec assez d'impressions", () => {
  row("2026-11-03", "recule", "/a", 5, 50, 4); row("2026-11-10", "recule", "/a", 1, 50, 9);
  row("2026-11-03", "stable", "/a", 5, 50, 4); row("2026-11-10", "stable", "/a", 5, 50, 5);
  row("2026-11-03", "rare", "/a", 1, 3, 2); row("2026-11-10", "rare", "/a", 0, 3, 15);
  for (const q of ["recule", "stable", "rare"]) trackKeyword(SITE, q);
  assert.deepEqual(keywordDrops(SITE, r).map((k) => k.query), ["recule"]);
});

test("diagnostics : pages qui perdent des clics, taux de clic bas pour la position, cannibalisation", () => {
  // Couche par page (query = '')
  row("2026-11-02", "", "/perd", 40, 400, 3); row("2026-11-09", "", "/perd", 10, 400, 6);
  row("2026-11-02", "", "/tient", 40, 400, 3); row("2026-11-09", "", "/tient", 38, 400, 3);
  row("2026-11-09", "", "/ctr-bas", 2, 1000, 2);   // 0,2 % en position 2, attendu ~15 %
  // Cannibalisation : deux pages se partagent la requête
  row("2026-11-09", "devis", "/x", 3, 60, 7); row("2026-11-09", "devis", "/y", 2, 40, 9);
  row("2026-11-09", "seule", "/x", 3, 90, 3); row("2026-11-09", "seule", "/y", 0, 5, 30);
  const d = seoInsights(SITE, r);
  assert.deepEqual(d.losing.map((x) => [x.page, x.lost]), [["/perd", 30]]);
  assert.deepEqual(d.lowCtr.map((x) => x.page), ["/ctr-bas"]);
  assert.equal(d.lowCtr[0].expected, expectedCtr(2));
  assert.deepEqual(d.cannibal.map((x) => [x.query, x.pages.map((p) => p.page)]), [["devis", ["/x", "/y"]]]);
});

test("suggestions : position 4 à 20, sans les mots-clés déjà suivis", () => {
  row("2026-11-09", "a suivre", "/a", 1, 200, 7);
  row("2026-11-09", "deja suivi", "/a", 1, 300, 6);
  row("2026-11-09", "premier", "/a", 50, 300, 1.5);
  trackKeyword(SITE, "deja suivi");
  assert.deepEqual(keywordSuggestions(SITE, r).map((x: any) => x.query), ["a suivre"]);
});

test("REST : liste, suivi et diagnostics ; site inconnu = 404", async () => {
  const app = new Hono();
  registerKeywords(app, (id) => db.prepare("SELECT id FROM sites WHERE id = ?").get(id) as { id: string } | undefined, () => r);
  const post = await app.request(`/api/sites/${SITE}/keywords`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "Devis" }) });
  assert.equal(post.status, 200);
  const list = await (await app.request(`/api/sites/${SITE}/keywords`)).json() as { tracked: { query: string }[] };
  assert.deepEqual(list.tracked.map((k) => k.query), ["devis"]);
  assert.equal((await app.request(`/api/sites/${SITE}/seo-insights`)).status, 200);
  assert.equal((await app.request("/api/sites/inconnu/keywords")).status, 404);
  const bad = await app.request(`/api/sites/${SITE}/keywords`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "" }) });
  assert.equal(bad.status, 400);
});
