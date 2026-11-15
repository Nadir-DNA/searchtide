// A5 : indexation — lecture du sitemap, inspection Google (réponses simulées), IndexNow (envoi simulé).
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db.ts";
import { setCollectContext } from "./connectors/use.ts";
import { realCtx } from "./connectors/registry.ts";
import { indexingStatus, inspectWith, pagesToSubmit, parseSitemap, submitIndexnow } from "./indexing.ts";

const SITE = { id: "site-index", domain: "index.test" };
let calls: { url: string; body: any }[] = [];
const fake = (respond: (url: string, body: any) => Response) => setCollectContext(realCtx({
  fetch: (async (u: any, i: RequestInit = {}) => { const body = i.body ? JSON.parse(String(i.body)) : null; calls.push({ url: String(u), body }); return respond(String(u), body); }) as typeof fetch,
}));
after(() => setCollectContext(undefined));
beforeEach(() => {
  calls = [];
  db.exec("DELETE FROM indexing_pages; DELETE FROM indexnow_keys; DELETE FROM sites");
  db.prepare("INSERT INTO sites (id, domain, name, created_at) VALUES (?, ?, ?, ?)").run(SITE.id, SITE.domain, SITE.domain, Date.now());
});
const page = (url: string, lastmod: string | null = null) => db.prepare("INSERT INTO indexing_pages (site_id, url, lastmod) VALUES (?, ?, ?)").run(SITE.id, url, lastmod);

test("sitemap : liste d'adresses avec dates, et index de sitemaps", () => {
  const set = parseSitemap(`<?xml version="1.0"?><urlset><url><loc>https://index.test/a?x=1&amp;y=2</loc><lastmod>2026-11-10</lastmod></url><url><loc> https://index.test/b </loc></url></urlset>`);
  assert.equal(set.index, false);
  assert.deepEqual(set.entries, [{ loc: "https://index.test/a?x=1&y=2", lastmod: "2026-11-10" }, { loc: "https://index.test/b", lastmod: null }]);
  const idx = parseSitemap(`<sitemapindex><sitemap><loc>https://index.test/s1.xml</loc></sitemap></sitemapindex>`);
  assert.equal(idx.index, true);
  assert.equal(idx.entries[0].loc, "https://index.test/s1.xml");
});

test("inspection Google : verdict et raison enregistrés, erreur gardée par page, arrêt au quota", async () => {
  page("https://index.test/ok"); page("https://index.test/non"); page("https://index.test/erreur"); page("https://index.test/quota");
  fake((_u, body) => {
    const u = body.inspectionUrl as string;
    if (u.endsWith("/ok")) return Response.json({ inspectionResult: { indexStatusResult: { verdict: "PASS", coverageState: "Envoyée et indexée", lastCrawlTime: "2026-11-12T08:00:00Z" } } });
    if (u.endsWith("/non")) return Response.json({ inspectionResult: { indexStatusResult: { verdict: "NEUTRAL", coverageState: "Explorée, actuellement non indexée" } } });
    if (u.endsWith("/erreur")) return Response.json({ error: { message: "URL hors propriété" } }, { status: 400 });
    return Response.json({}, { status: 429 });
  });
  const r = await inspectWith(SITE, "sc-domain:index.test", "jeton");
  assert.equal(r.inspected, 2); assert.equal(r.failed, 1);
  assert.equal(calls[0].body.siteUrl, "sc-domain:index.test");
  const st = indexingStatus(SITE.id);
  assert.equal(st.indexed, 1); assert.equal(st.notIndexed, 1);
  assert.deepEqual(st.problems.map((p: any) => p.url).sort(), ["https://index.test/erreur", "https://index.test/non"]);
  assert.equal(st.unknown, 2, "la page en erreur et celle du quota restent à lire");
  // Relancé tout de suite : les pages lues il y a moins de 7 jours ne sont pas reprises
  calls = [];
  await inspectWith(SITE, "sc-domain:index.test", "jeton");
  assert.deepEqual(calls.map((c) => c.body.inspectionUrl), ["https://index.test/quota"]);
});

test("IndexNow : clé vérifiée exigée, envoi des pages nouvelles, refus sans rien marquer, page modifiée renvoyée", async () => {
  page("https://index.test/a", "2026-11-10"); page("https://index.test/b"); page("https://ailleurs.test/x");
  db.prepare("INSERT INTO indexnow_keys (site_id, key) VALUES (?, ?)").run(SITE.id, "cle0123456789abcdef");
  await assert.rejects(submitIndexnow(SITE), /fichier de clé/);
  db.prepare("UPDATE indexnow_keys SET verified_at = ? WHERE site_id = ?").run(Date.now(), SITE.id);

  fake(() => new Response(null, { status: 403 }));
  await assert.rejects(submitIndexnow(SITE), /Clé refusée/);
  assert.equal(pagesToSubmit(SITE.id).length, 3, "rien n'est marqué envoyé après un refus");

  fake(() => new Response(null, { status: 200 }));
  const r = await submitIndexnow(SITE);
  assert.equal(r.submitted, 2, "l'adresse d'un autre domaine n'est jamais envoyée");
  assert.equal(calls.at(-1)!.url, "https://api.indexnow.org/indexnow");
  assert.deepEqual(calls.at(-1)!.body.urlList.sort(), ["https://index.test/a", "https://index.test/b"]);
  assert.equal(calls.at(-1)!.body.keyLocation, "https://index.test/cle0123456789abcdef.txt");
  assert.deepEqual(pagesToSubmit(SITE.id), ["https://ailleurs.test/x"], "déjà envoyées : plus en attente");
  db.prepare("UPDATE indexing_pages SET lastmod = '2099-01-01' WHERE url = ?").run("https://index.test/a");
  assert.ok(pagesToSubmit(SITE.id).includes("https://index.test/a"), "modifiée depuis l'envoi : à renvoyer");
});
