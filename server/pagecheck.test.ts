// A2 : vérificateur de page (analyse HTML, robots.txt) et lecture sûre (aucune adresse interne).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { analyzeHtml, hostAllowed, pageUrlFor, registerPageCheck, robotsAllows } from "./pagecheck.ts";
import { checkUrl, safeGet, setResolver, SafeFetchError } from "./safe-fetch.ts";

const by = (checks: { id: string }[], id: string) => checks.find((c) => c.id === id) as any;

test("analyse : page complète", () => {
  const html = `<!doctype html><html lang="fr"><head>
    <title>Analytics sans cookie pour PME, simple et gratuit</title>
    <meta name="description" content="Mesurez vos visites sans bannière cookie : tableau de bord clair, données chez vous, installation en deux minutes.">
    <meta name="viewport" content="width=device-width">
    <link rel="canonical" href="https://exemple.com/tarifs">
    <meta property="og:title" content="t"><meta property="og:description" content="d"><meta property="og:image" content="i.png">
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization"},{"@type":["Product","Thing"]}]}</script>
    </head><body><h1>Tarifs</h1><img src="a.png" alt="graphique"><a href="/contact">Contact</a><a href="https://ailleurs.fr">x</a>
    <p>${"mot ".repeat(300)}</p></body></html>`;
  const c = analyzeHtml(html, "https://exemple.com/tarifs");
  for (const id of ["title", "description", "h1", "canonical", "robots-meta", "lang", "viewport", "open-graph", "schema", "images-alt", "links", "words"]) assert.equal(by(c, id).status, "ok", `${id} : ${JSON.stringify(by(c, id))}`);
  assert.match(by(c, "schema").value, /Organization, Product, Thing/);
  assert.equal(by(c, "links").value, "1 internes, 1 externes");
});

test("analyse : page lacunaire, chaque point dit quoi faire", () => {
  const html = `<html><head><title>Court</title><meta name="robots" content="noindex, follow">
    <script type="application/ld+json">{ pas du json }</script></head><body><h1>A</h1><h1>B</h1><img src="x.png"><p>peu</p></body></html>`;
  const c = analyzeHtml(html, "https://exemple.com/");
  assert.equal(by(c, "title").status, "warn");
  assert.equal(by(c, "description").status, "warn");
  assert.equal(by(c, "h1").status, "warn");
  assert.equal(by(c, "robots-meta").status, "bad");
  assert.equal(by(c, "viewport").status, "bad");
  assert.equal(by(c, "schema").status, "bad");
  assert.equal(by(c, "images-alt").value, "1 sur 1");
  for (const x of c.filter((x) => x.status !== "ok" && x.status !== "info")) assert.ok(x.advice, `${x.id} sans conseil`);
});

test("robots.txt : groupe Googlebot prioritaire, règle la plus longue, jokers, sitemaps", () => {
  const txt = `User-agent: *\nDisallow: /\n\nUser-agent: Googlebot\nDisallow: /prive/\nAllow: /prive/public\nDisallow: /*.pdf$\nSitemap: https://exemple.com/sitemap.xml`;
  assert.equal(robotsAllows(txt, "/tarifs").allowed, true);
  assert.equal(robotsAllows(txt, "/prive/x").allowed, false);
  assert.equal(robotsAllows(txt, "/prive/public/page").allowed, true);
  assert.equal(robotsAllows(txt, "/doc.pdf").allowed, false);
  assert.equal(robotsAllows(txt, "/tarifs", "bingbot").allowed, false, "les autres robots tombent dans le groupe *");
  assert.deepEqual(robotsAllows(txt, "/").sitemaps, ["https://exemple.com/sitemap.xml"]);
});

test("lecture sûre : adresses internes, ports et identifiants refusés, résolution vers une adresse privée refusée", async () => {
  for (const u of ["http://127.0.0.1/", "http://localhost/", "http://metadata/", "http://10.0.0.1/", "http://[::1]/", "http://0x7f.1/", "ftp://exemple.com/", "https://exemple.com:8443/", "https://a:b@exemple.com/"])
    assert.throws(() => checkUrl(u), SafeFetchError, u);
  setResolver(async () => ["10.0.0.5"]);
  await assert.rejects(safeGet("https://piege.exemple/"), /Adresse refusée/);
  setResolver(async () => ["93.184.216.34", "169.254.169.254"]);
  await assert.rejects(safeGet("https://mixte.exemple/"), /Adresse refusée/, "une seule adresse interne suffit à refuser");
});

test("domaine du site seulement : sous-domaines admis, autre domaine refusé par la route", async () => {
  assert.equal(hostAllowed("exemple.com")("www.exemple.com"), true);
  assert.equal(hostAllowed("exemple.com")("exemple.com.evil.fr"), false);
  assert.equal(pageUrlFor("exemple.com", "/tarifs"), "https://exemple.com/tarifs");
  const app = new Hono();
  registerPageCheck(app, (id) => (id === "s1" ? { id: "s1", domain: "exemple.com" } : undefined));
  const r = await app.request("/api/sites/s1/page-check?url=" + encodeURIComponent("https://autre.fr/"));
  assert.equal(r.status, 400);
  assert.match((await r.json() as { error: string }).error, /hors du site/);
  assert.equal((await app.request("/api/sites/inconnu/page-check")).status, 404);
});
