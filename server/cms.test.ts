// B4 : WordPress — test de connexion, article en brouillon par défaut, correction de titre trouvée par adresse.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createConnection } from "./connections.ts";
import { setCollectContext } from "./connectors/use.ts";
import { simCtx } from "./connectors/sim.ts";
import "./connectors/index.ts";
import { FIXTURES } from "./connectors/fixtures.ts";
import { fixTitle, publishArticle, toHtml, wordpressFor } from "./cms.ts";

const sent: { url: string; init: RequestInit }[] = [];
setCollectContext(simCtx({ fetch: (async (u: any, i: RequestInit = {}) => { sent.push({ url: String(u), init: i }); return FIXTURES.wordpress.respond!(String(u), i); }) as typeof fetch }));
after(() => setCollectContext(undefined));
process.env.SECRET ??= "secret-de-test-".repeat(4);
const f = FIXTURES.wordpress.cfg;
createConnection({ kind: "wordpress", label: "blog.exemple.test", config: f.config, secrets: f.secrets } as any);

test("Markdown léger vers HTML, échappé", () => {
  assert.equal(toHtml("# Titre\n\nUn **mot** et <script>.\n\n- a\n- b"), "<h2>Titre</h2>\n<p>Un <strong>mot</strong> et &lt;script&gt;.</p>\n<ul><li>a</li><li>b</li></ul>");
});

test("connexion retrouvée par domaine ; article créé en brouillon sauf demande explicite", async () => {
  assert.ok(wordpressFor("blog.exemple.test"));
  assert.equal(wordpressFor("autre.test"), null);
  const r = await publishArticle("blog.exemple.test", { title: "Guide 2026", content: "Premier paragraphe." });
  assert.equal(r.status, "draft");
  const post = sent.find((s) => s.url.endsWith("/wp-json/wp/v2/posts") && s.init.method === "POST")!;
  assert.match(String((post.init.headers as any).Authorization), /^Basic /);
  assert.equal(JSON.parse(String(post.init.body)).content, "<p>Premier paragraphe.</p>");
  assert.equal((await publishArticle("blog.exemple.test", { title: "T", content: "C", status: "publish" })).status, "publish");
  await assert.rejects(publishArticle("autre.test", { title: "T", content: "C" }), /Aucune connexion WordPress/);
});

test("titre corrigé sur l'article trouvé par son adresse ; adresse hors du site ou introuvable refusée", async () => {
  const r = await fixTitle("blog.exemple.test", "https://blog.exemple.test/guide/", "Guide complet de la pompe à chaleur en 2026");
  assert.deepEqual([r.id, r.type, r.before], [42, "posts", "Ancien titre"]);
  const update = sent.find((s) => /\/posts\/42$/.test(s.url))!;
  assert.equal(JSON.parse(String(update.init.body)).title, "Guide complet de la pompe à chaleur en 2026");
  await assert.rejects(fixTitle("blog.exemple.test", "https://autre.test/guide/", "Un titre assez long"), /hors du site/);
  await assert.rejects(fixTitle("blog.exemple.test", "https://blog.exemple.test/inconnue/", "Un titre assez long"), /introuvable/);
  await assert.rejects(fixTitle("blog.exemple.test", "https://blog.exemple.test/guide/", "court"), /10 à 120/);
});
