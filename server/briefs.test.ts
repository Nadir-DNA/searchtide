// B3 : brief construit depuis Search Console et les pages concurrentes ; brouillon par l'IA ; envoi WordPress en brouillon.
import { test } from "node:test";
import assert from "node:assert/strict";
process.env.SECRET ??= "secret-de-test-".repeat(4);
import { db, type Site } from "./db.ts";
import { createConnection } from "./connections.ts";
import "./connectors/index.ts";
import { lastDays } from "./stats.ts";
import { buildBrief, createBrief, draftBrief, draftPrompt, pageOutline, topicIdeas, words } from "./briefs.ts";

const SITE = "site-briefs";
db.prepare("INSERT INTO sites (id, domain, name, created_at) VALUES (?, ?, ?, ?)").run(SITE, "toiture.test", "toiture.test", Date.now());
const site = db.prepare("SELECT * FROM sites WHERE id = ?").get(SITE) as Site;
const day = lastDays(10).to;
const row = (query: string, page: string, clicks: number, impressions: number, position: number) =>
  db.prepare("INSERT INTO gsc_rows (site_id, day, query, page, clicks, impressions, position) VALUES (?, ?, ?, ?, ?, ?, ?)").run(SITE, day, query, page, clicks, impressions, position);
row("devis toiture", "https://toiture.test/devis", 3, 400, 9);
row("prix toiture au m2", "https://toiture.test/prix", 10, 300, 6);
row("comment choisir son couvreur toiture", "https://toiture.test/couvreur", 1, 120, 14);
row("refaire toiture combien", "https://toiture.test/prix", 0, 80, 18);
row("chaussures de sport", "https://toiture.test/hors-sujet", 0, 900, 12);

test("mots significatifs : sans accents ni mots vides", () => {
  assert.deepEqual(words("Comment refaire sa Toiture à Lyon ?"), ["refaire", "toiture", "lyon"]);
});

test("idées de sujets : position 5 à 30 avec impressions, sans celles qui ont déjà un brief", async () => {
  const ideas = topicIdeas(SITE).map((i) => i.query);
  assert.ok(ideas.includes("devis toiture") && ideas.includes("chaussures de sport"));
  await createBrief(site, "chaussures de sport");
  assert.ok(!topicIdeas(SITE).some((i) => i.query === "chaussures de sport"));
});

test("brief : requêtes voisines, questions, page actuelle, liens internes ; concurrents analysés, longueur visée", async () => {
  const html = (n: number) => `<html><head><title>Concurrent ${n}</title></head><body><nav>menu</nav><h1>Devis toiture</h1><h2>Prix</h2><h3>Au m2</h3><p>${"mot ".repeat(900 + n * 100)}</p><script>x()</script></body></html>`;
  const b = await buildBrief(site, "devis toiture", ["https://a.test/1", "https://b.test/2", "https://c.test/3"], async (u) => {
    if (u.includes("c.test")) throw new Error("réponse 403");
    return html(u.includes("b.test") ? 2 : 1);
  });
  assert.equal(b.page, "https://toiture.test/devis");
  assert.equal(b.position, 9);
  assert.deepEqual(b.related.map((x) => x.query), ["prix toiture au m2"]);
  assert.deepEqual(b.questions.sort(), ["comment choisir son couvreur toiture", "refaire toiture combien"]);
  assert.ok(b.links.some((l) => l.page === "https://toiture.test/prix"));
  assert.ok(!b.links.some((l) => l.page.includes("hors-sujet")), "la requête hors sujet ne sert pas");
  assert.deepEqual(b.competitors[0].headings, ["Prix", "  Au m2"]);
  assert.equal(b.competitors[2].error, "réponse 403");
  assert.equal(b.length, 1200, "médiane 1000/1100 mots × 1,1 arrondie à la centaine");
  assert.match(draftPrompt(b, "toiture.test"), /\[à compléter\]/);
  assert.equal(pageOutline("<h1>T</h1><p>un deux</p>", "u").words, 3);
});

test("brouillon par l'IA : titre repris de la première ligne, texte enregistré ; sans IA, message clair", async () => {
  db.prepare("DELETE FROM connections WHERE kind = 'ai'").run();
  const b = await createBrief(site, "prix toiture au m2");
  await assert.rejects(draftBrief(b.id), /Aucune IA connectée/);
  createConnection({ kind: "ai", label: "GPT", config: { provider: "openai", model: "gpt-test" }, secrets: { api_key: "sk-test-0123456789" } } as any);
  let prompt = "";
  const f = (async (u: any, i: any) => {
    assert.equal(String(u), "https://api.openai.com/v1/chat/completions");
    prompt = JSON.parse(String(i.body)).messages[1].content;
    return new Response(JSON.stringify({ choices: [{ message: { content: "# Prix d'une toiture au m² en 2026\n\n## Ce qui fait le prix\nTexte." } }] }), { status: 200 });
  }) as typeof fetch;
  const d = await draftBrief(b.id, { fetch: f });
  assert.match(prompt, /prix toiture au m2/);
  assert.equal(d.title, "Prix d'une toiture au m² en 2026");
  assert.equal(d.draft, "## Ce qui fait le prix\nTexte.");
  assert.equal(d.status, "draft");
});
