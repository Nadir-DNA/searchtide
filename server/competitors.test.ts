// A6 : analyse des concurrents — faits d'une page, écarts à la médiane, garde-fous d'adresses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, type Site } from "./db.ts";
import { compare, gaps, pageFacts, saveCompetitors, savedCompetitors } from "./competitors.ts";

db.prepare("INSERT INTO sites (id, domain, name, created_at) VALUES ('s-conc', 'moi.test', 'moi.test', 0)").run();
const site = db.prepare("SELECT * FROM sites WHERE id = 's-conc'").get() as Site;

const page = (o: { words: number; h2: string[]; schema?: string; desc?: boolean }) => `<html><head><title>Titre de page assez long</title>
${o.desc === false ? "" : '<meta name="description" content="Une description">'}<meta property="og:title" content="T"><meta property="og:image" content="i.png">
${o.schema ? `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"${o.schema}"}]}</script>` : ""}</head>
<body><nav><a href="/menu">menu</a></nav><h1>Devis toiture</h1>${o.h2.map((h) => `<h2>${h}</h2>`).join("")}<p>${"mot ".repeat(o.words)}</p>
<img src="a.jpg"><img src="b.jpg" alt="b"><a href="/interne">i</a><a href="https://ailleurs.test/x">e</a></body></html>`;

test("faits d'une page : mots hors menus, intertitres, JSON-LD (avec @graph), images sans alt, liens", () => {
  const f = pageFacts(page({ words: 100, h2: ["Prix ?", "Délais"], schema: "FAQPage" }), "https://moi.test/devis");
  assert.equal(f.h1, "Devis toiture"); assert.deepEqual(f.h2, ["Prix ?", "Délais"]); assert.equal(f.faq, 1);
  assert.deepEqual(f.schema, ["FAQPage"]); assert.equal(f.images, 2); assert.equal(f.imagesNoAlt, 1);
  assert.equal(f.internalLinks, 1, "le lien du menu ne compte pas, le lien interne du contenu oui"); assert.equal(f.externalLinks, 1);
  assert.ok(f.words >= 100 && f.words < 120); assert.ok(f.openGraph);
});

test("écarts : contenu court, structure, balisage partagé, sujets manquants, description absente", async () => {
  const pages: Record<string, string> = {
    "https://moi.test/devis": page({ words: 200, h2: ["Notre offre"], desc: false }),
    "https://a.test/1": page({ words: 1200, h2: ["Prix toiture", "Délais chantier", "Garantie décennale", "Pourquoi nous ?", "Comment ça marche ?"], schema: "FAQPage" }),
    "https://b.test/2": page({ words: 1000, h2: ["Prix moyen", "Garantie décennale", "Délais", "Quel matériau ?", "Combien de temps ?"], schema: "FAQPage" }),
    "https://c.test/3": "",
  };
  const r = await compare(site, "/devis", ["https://a.test/1", "https://b.test/2", "https://c.test/3"], async (u) => {
    if (!pages[u]) return { status: 404, body: "", ms: 10, bytes: 0 };
    return { status: 200, body: pages[u], ms: u.includes("moi") ? 900 : 100, bytes: pages[u].length };
  });
  assert.equal(r.competitors[2].error, "réponse 404");
  const text = r.gaps.map((g) => g.text).join("\n");
  assert.match(text, /Contenu plus court : \d+ mots contre \d+/);
  assert.match(text, /Moins structuré/);
  assert.match(text, /« FAQPage » utilisées par 2 concurrents/);
  assert.match(text, /format FAQ/);
  assert.match(text, /garantie/); assert.match(text, /decennale/);
  assert.match(text, /Pas de meta description/);
  assert.match(text, /plus lente/);
  assert.equal(r.gaps[0].level, "bad", "le plus important d'abord");
  assert.deepEqual(gaps({ ...r.mine, error: "x" }, r.competitors), []);
});

test("garde-fous : votre page doit être sur votre site, les concurrents ailleurs ; liste enregistrée", async () => {
  const f = async () => ({ status: 200, body: "<html></html>", ms: 1, bytes: 1 });
  await assert.rejects(compare(site, "https://autre.test/x", ["https://a.test"], f), /hors du site/);
  await assert.rejects(compare(site, "/", ["https://blog.moi.test/x"], f), /votre propre site/);
  await assert.rejects(compare(site, "/", [], f), /au moins une page/);
  assert.deepEqual(saveCompetitors("s-conc", ["https://a.test/1", "pas une adresse"]), ["https://a.test/1"]);
  assert.deepEqual(savedCompetitors("s-conc"), ["https://a.test/1"]);
});
