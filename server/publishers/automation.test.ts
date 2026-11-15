// D4, D5, D8, D10 : publications récurrentes, flux RSS, meilleurs créneaux, webhooks sortants.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { db } from "../db.ts";
import { savePublication } from "../business.ts";
import { createAccount, getPublication, queuePublication } from "./queue.ts";
import { addFeed, addWebhook, bestSlots, checkFeed, fillTemplate, parseFeed, scheduleRepeats, setRepeat, setWebhookSender, signBody } from "./automation.ts";

const uniq = () => `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
function account(network = "x") {
  const project = uniq();
  db.prepare("INSERT INTO projects (id, name, crm_key, created_at) VALUES (?, ?, ?, 0)").run(`id-${project}`, project, project);
  return { project, id: (createAccount({ project, network, label: `Compte ${network}` }) as any).id as string };
}

test("RSS et Atom : titre, lien, identifiant ; modèle de texte", () => {
  const rss = parseFeed(`<rss><channel><item><title><![CDATA[Nouvel article & astuces]]></title><link>https://blog.test/a</link><guid>g-a</guid></item></channel></rss>`);
  assert.deepEqual(rss, [{ guid: "g-a", title: "Nouvel article & astuces", link: "https://blog.test/a" }]);
  const atom = parseFeed(`<feed><entry><title>Billet</title><link href="https://blog.test/b"/><id>tag:b</id></entry></feed>`);
  assert.deepEqual(atom, [{ guid: "tag:b", title: "Billet", link: "https://blog.test/b" }]);
  assert.equal(fillTemplate("À lire : {titre} {lien}", { title: "T", link: "https://l" }), "À lire : T https://l");
});

test("flux : premier passage mémorisé sans rien créer, puis un brouillon par compte pour chaque nouvel article", async () => {
  const a = account(), b = account("linkedin");
  db.prepare("UPDATE pub_accounts SET project = ? WHERE id = ?").run(a.project, b.id);
  const feed = addFeed({ url: "https://blog.test/flux.xml", accounts: [a.id, b.id], template: "{titre} {lien}" }) as any;
  let xml = `<rss><channel><item><title>Ancien</title><link>https://blog.test/old</link><guid>old</guid></item></channel></rss>`;
  const r1 = await checkFeed(feed, async () => xml);
  assert.deepEqual(r1, { created: 0, first: true });
  xml = `<rss><channel><item><title>Nouveau</title><link>https://blog.test/new</link><guid>new</guid></item><item><title>Ancien</title><link>https://blog.test/old</link><guid>old</guid></item></channel></rss>`;
  const r2 = await checkFeed(db.prepare("SELECT * FROM rss_feeds WHERE id = ?").get(feed.id) as any, async () => xml);
  assert.equal(r2.created, 1);
  const pubs = db.prepare("SELECT text, account_id, state FROM publications WHERE title = 'Nouveau'").all() as any[];
  assert.equal(pubs.length, 2);
  assert.ok(pubs.every((p) => p.text === "Nouveau https://blog.test/new" && p.state === "draft"));
  const r3 = await checkFeed(db.prepare("SELECT * FROM rss_feeds WHERE id = ?").get(feed.id) as any, async () => xml);
  assert.equal(r3.created, 0, "déjà vu : rien de recréé");
  await checkFeed(db.prepare("SELECT * FROM rss_feeds WHERE id = ?").get(feed.id) as any, async () => { throw new Error("flux introuvable (404)"); });
  assert.match((db.prepare("SELECT error FROM rss_feeds WHERE id = ?").get(feed.id) as any).error, /404/);
});

test("répétition : la publication publiée donne sa suivante N jours plus tard, une seule fois", async () => {
  const a = account();
  const p = savePublication(null, { day: new Date().toISOString().slice(0, 10), title: "Rappel", project: a.project, network: "x", text: "Rappel mensuel" }) as any;
  const publishedAt = Date.now() - 1000;
  db.prepare("UPDATE publications SET account_id = ?, state = 'published', published_at = ? WHERE id = ?").run(a.id, publishedAt, p.id);
  setRepeat(p.id, 30);
  assert.equal(await scheduleRepeats(), 1);
  const parent = getPublication(p.id)!;
  const child = getPublication(parent.repeat_child)!;
  assert.equal(child.text, "Rappel mensuel");
  assert.equal(child.state, "scheduled");
  assert.equal(child.repeat_days, 30, "la suivante se répète aussi");
  assert.ok(Math.abs(Number(child.scheduled_at) - (publishedAt + 30 * 86_400_000)) < 1000);
  assert.equal(await scheduleRepeats(), 0, "pas de doublon");
});

test("meilleurs créneaux : rien sous 5 publications mesurées, puis le jour et l'heure les plus engageants", () => {
  const a = account();
  const mk = (at: Date, likes: number) => {
    const p = savePublication(null, { day: at.toISOString().slice(0, 10), title: "M", project: a.project, network: "x", text: "m" }) as any;
    db.prepare("UPDATE publications SET account_id = ?, state = 'published', published_at = ? WHERE id = ?").run(a.id, at.getTime(), p.id);
    db.prepare("INSERT INTO post_stats (publication_id, likes, updated_at) VALUES (?, ?, ?)").run(p.id, likes, Date.now());
  };
  const tue9 = new Date(2026, 10, 10, 9), fri18 = new Date(2026, 10, 13, 18);
  for (let i = 0; i < 2; i++) mk(tue9, 10);
  assert.equal(bestSlots({ account: a.id }).enough, false);
  mk(tue9, 12); mk(fri18, 80); mk(fri18, 90);
  const s = bestSlots({ account: a.id });
  assert.equal(s.enough, true);
  assert.deepEqual([s.slots[0].weekday, s.slots[0].hour], [5, 18]);
  assert.equal(s.slots[0].engagement, 85);
});

test("webhooks : https seulement, corps signé, envoyé quand une publication passe « publiée »", async () => {
  assert.throws(() => addWebhook({ url: "http://n8n.test/hook" }), /https/);
  const hook = addWebhook({ url: "https://n8n.test/hook", events: ["published"] });
  const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
  setWebhookSender(async (url, body, headers) => { calls.push({ url, body, headers }); return 200; });
  const a = account();
  const p = savePublication(null, { day: new Date().toISOString().slice(0, 10), title: "Annonce", project: a.project, network: "x", text: "Bonjour" }) as any;
  await queuePublication(p.id, { now: true, account_id: a.id, text: "Bonjour" });
  await new Promise((r) => setTimeout(r, 20));
  const call = calls.find((c) => JSON.parse(c.body).publication.id === p.id)!;
  assert.ok(call, "webhook appelé");
  assert.equal(call.headers["x-searchtide-event"], "published");
  assert.equal(call.headers["x-searchtide-signature"], `sha256=${createHmac("sha256", hook.secret).update(call.body).digest("hex")}`);
  assert.equal(signBody(hook.secret, call.body), call.headers["x-searchtide-signature"]);
  assert.match(JSON.parse(call.body).publication.url, /^https:\/\/sim\.test\//);
  db.prepare("DELETE FROM webhooks").run();
});
