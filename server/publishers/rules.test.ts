// D7 : actions sur seuil — une fois par publication, rien de rétroactif, règles d'agent désactivées par défaut.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../db.ts";
import { savePublication } from "../business.ts";
import { createAccount, queuePublication } from "./queue.ts";
import { createRule, evaluateRules } from "./rules.ts";
import { followupsOf } from "./followups.ts";
import { today } from "../today.ts";

const uniq = () => `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
function account(network = "linkedin") {
  const project = uniq();
  db.prepare("INSERT INTO projects (id, name, crm_key, sites, created_at) VALUES (?, ?, ?, '[]', 0)").run(`id-${project}`, project, project);
  return { project, id: (createAccount({ project, network, label: `Compte ${network}` }) as any).id as string };
}
async function published(a: { project: string; id: string }, network: string, likes: number, at = Date.now()) {
  const p = savePublication(null, { day: new Date().toISOString().slice(0, 10), title: `Post ${uniq()}`, project: a.project, network, text: `Texte ${uniq()}` }) as any;
  db.prepare("UPDATE publications SET account_id = ? WHERE id = ?").run(a.id, p.id);
  await queuePublication(p.id, { now: true });
  db.prepare("UPDATE publications SET published_at = ? WHERE id = ?").run(at, p.id);
  db.prepare("INSERT INTO post_stats (publication_id, likes, comments, shares, updated_at) VALUES (?, ?, 2, 1, ?)").run(p.id, likes, Date.now());
  return p.id as string;
}

test("seuil atteint : commentaire mis en file une seule fois ; sous le seuil, rien", async () => {
  const a = account("linkedin");
  const rule = createRule({ account_id: a.id, metric: "likes", threshold: 100, action: "comment", text: "Merci pour vos 100 j'aime !" });
  const hot = await published(a, "linkedin", 150), cold = await published(a, "linkedin", 20);
  assert.equal(await evaluateRules(), 1);
  assert.deepEqual((followupsOf(hot) as any[]).map((f) => [f.kind, f.text]), [["comment", "Merci pour vos 100 j'aime !"]]);
  assert.deepEqual(followupsOf(cold), []);
  assert.equal(await evaluateRules(), 0, "jamais deux fois");
  assert.equal((db.prepare("SELECT result FROM pub_rule_fires WHERE rule_id = ?").get(rule.id) as any).result, "commentaire en file");
});

test("pas d'effet rétroactif : un post paru avant la règle ne la déclenche pas", async () => {
  const a = account("linkedin");
  await published(a, "linkedin", 999, Date.now() - 86_400_000);
  createRule({ account_id: a.id, metric: "engagement", threshold: 10, action: "todo" });
  assert.equal(await evaluateRules(), 0);
});

test("republier : copie programmée après le délai ; X exige un nouveau texte", async () => {
  const x = account("x");
  assert.throws(() => createRule({ account_id: x.id, metric: "likes", threshold: 5, action: "repost" }), /doublons/);
  const a = account("facebook");
  createRule({ account_id: a.id, metric: "likes", threshold: 5, action: "repost", delay_hours: 48 });
  const before = Date.now();
  const id = await published(a, "facebook", 50);
  await evaluateRules(before + 1000);
  const copy = db.prepare("SELECT * FROM publications WHERE title LIKE '%(republication)' AND account_id = ?").get(a.id) as any;
  assert.ok(copy, "copie créée");
  assert.equal(copy.state, "scheduled");
  assert.equal(copy.text, (db.prepare("SELECT text FROM publications WHERE id = ?").get(id) as any).text);
  assert.ok(Math.abs(copy.scheduled_at - (before + 1000 + 48 * 3_600_000)) < 5000);
});

test("« À traiter » : le seuil atteint y apparaît ; une règle proposée par un agent reste désactivée", async () => {
  const a = account("linkedin");
  createRule({ account_id: a.id, metric: "likes", threshold: 10, action: "todo" });
  const id = await published(a, "linkedin", 12);
  await evaluateRules();
  assert.ok(today().some((i) => i.key.includes(id) && /a atteint 12 j'aime/.test(i.text)));
  const r = createRule({ account_id: a.id, metric: "likes", threshold: 1, action: "todo" }, "Agent SEO");
  assert.equal(r.enabled, 0);
  assert.throws(() => createRule({ account_id: a.id, metric: "followers", threshold: 1, action: "todo" }), /Mesure inconnue/);
  assert.throws(() => createRule({ account_id: account("tiktok").id, metric: "likes", threshold: 1, action: "comment", text: "x" }), /non pris en charge/);
});
