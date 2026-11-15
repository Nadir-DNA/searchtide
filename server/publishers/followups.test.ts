// D6 : premier commentaire, fils, hashtags ; D1 : cible (subreddit) réglée par compte.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../db.ts";
import { savePublication } from "../business.ts";
import { createAccount, getPublication, queuePublication, setAccountTarget, validatePublication } from "./queue.ts";
import { countHashtags, followupsOf, retryFollowup, runFollowups, setFollowups, setHashtags, hashtagsOf } from "./followups.ts";
import { createBatch } from "./batch.ts";
import { splitThread } from "../../web/src/thread.ts";

const uniq = () => `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
function account(network = "x") {
  const project = uniq();
  db.prepare("INSERT INTO projects (id, name, crm_key, created_at) VALUES (?, ?, ?, 0)").run(`id-${project}`, project, project);
  return { project, id: (createAccount({ project, network, label: `Compte ${network}` }) as any).id as string };
}
const draft = (a: { project: string; id: string }, network = "x", text = "Bonjour") => {
  const p = savePublication(null, { day: new Date().toISOString().slice(0, 10), title: "T", project: a.project, network, text }) as any;
  db.prepare("UPDATE publications SET account_id = ? WHERE id = ?").run(a.id, p.id);
  return p.id as string;
};

test("découpe en fil : parties numérotées sous la limite, rien de perdu", () => {
  const text = Array.from({ length: 12 }, (_, i) => `Phrase numéro ${i + 1} qui raconte quelque chose d'utile.`).join(" ");
  const parts = splitThread(text, 120);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= 120), parts.map((p) => p.length).join(","));
  assert.match(parts[0], / 1\/\d+$/); assert.match(parts.at(-1)!, new RegExp(` ${parts.length}/${parts.length}$`));
  assert.equal(parts.map((p) => p.replace(/ \d+\/\d+$/, "")).join(" ").replace(/\s+/g, " "), text);
  assert.deepEqual(splitThread("court", 280), ["court"]);
});

test("fil et premier commentaire : envoyés après la publication, chaque partie répond à la précédente", async () => {
  const a = account("x");
  const id = draft(a);
  setFollowups(id, { thread: ["Partie deux", "Partie trois"], first_comment: "Le lien : https://monsite.fr" });
  await queuePublication(id, { now: true });
  assert.equal(getPublication(id)!.state, "published");
  const calls: [string, string][] = [];
  const sent = await runFollowups(async (_acc, parent, text) => { calls.push([parent, text]); return { ok: true, url: `${parent.split("#")[0]}#${calls.length}` }; });
  assert.equal(sent, 3);
  const main = String(getPublication(id)!.evidence_url);
  assert.deepEqual(calls, [[main, "Partie deux"], [`${main}#1`, "Partie trois"], [main, "Le lien : https://monsite.fr"]]);
  assert.equal(await runFollowups(async () => { throw new Error("ne doit pas être rappelé"); }), 0, "rien n'est renvoyé");
  assert.ok((followupsOf(id) as any[]).every((f) => f.state === "sent"));
});

test("fil : une partie en doute arrête la suite, rien n'est rejoué ; reprise à la main", async () => {
  const a = account("x");
  const id = draft(a);
  setFollowups(id, { thread: ["Deux", "Trois"] });
  await queuePublication(id, { now: true });
  await runFollowups(async () => ({ ok: false, kind: "to_verify", message: "délai dépassé" }));
  let f = followupsOf(id) as any[];
  assert.deepEqual(f.map((x) => x.state), ["to_verify", "pending"]);
  assert.equal(await runFollowups(async () => ({ ok: true, url: "https://x.com/i/status/9" })), 0, "la partie suivante attend la décision");
  retryFollowup(id, 1, "sent", "https://x.com/i/status/8");
  assert.equal(await runFollowups(async (_a, parent) => { assert.equal(parent, "https://x.com/i/status/8"); return { ok: true, url: "https://x.com/i/status/9" }; }), 1);
  f = followupsOf(id) as any[];
  assert.deepEqual(f.map((x) => x.state), ["sent", "sent"]);
});

test("suites refusées avant l'envoi : fil hors X, partie trop longue, trop de hashtags Instagram ; figées une fois en file", async () => {
  const li = account("linkedin");
  const id = draft(li, "linkedin");
  setFollowups(id, { thread: ["suite"] });
  assert.ok(validatePublication(getPublication(id)!, db.prepare("SELECT * FROM pub_accounts WHERE id = ?").get(li.id) as any).some((m) => /Fil non pris en charge/.test(m)));
  const x = account("x");
  const id2 = draft(x);
  setFollowups(id2, { thread: ["a".repeat(300)] });
  await assert.rejects(queuePublication(id2, { now: true }), /Partie 2 du fil trop longue/);
  const ig = account("instagram");
  const tags = Array.from({ length: 31 }, (_, i) => `#t${i}`).join(" ");
  assert.equal(countHashtags(tags), 31);
  assert.ok(validatePublication({ network: "instagram", project: ig.project, text: tags, media: [] }, db.prepare("SELECT * FROM pub_accounts WHERE id = ?").get(ig.id) as any).some((m) => /31 hashtags, 30 au plus/.test(m)));
  const id3 = draft(x);
  await queuePublication(id3, { at: Date.now() + 3_600_000 });
  assert.throws(() => setFollowups(id3, { first_comment: "trop tard" }), /déjà en file/);
});

test("composer : premier commentaire et fil passent par le lot multi-comptes", async () => {
  const a = account("x");
  const r = await createBatch({ title: "Lot", day: new Date().toISOString().slice(0, 10), items: [{ account_id: a.id, text: "Un", thread: ["Deux"], first_comment: "Com" }] });
  const p = getPublication(r.items[0].id)!;
  assert.equal(p.first_comment, "Com"); assert.deepEqual(JSON.parse(p.thread), ["Deux"]);
});

test("hashtags du projet : nettoyés, sans doublon, par réseau", () => {
  const a = account("instagram");
  assert.deepEqual(setHashtags(a.project, "instagram", "#cuisine cuisine, #fait-maison #recette"), { instagram: "#cuisine #recette" });
  setHashtags(a.project, "instagram", "");
  assert.deepEqual(hashtagsOf(a.project), {});
});

test("Reddit : subreddit réglé sur le compte, vérifié ; titre requis", () => {
  const a = account("reddit");
  db.prepare("UPDATE pub_accounts SET connection_id = 'c-fictif' WHERE id = ?").run(a.id);
  const acc = () => db.prepare("SELECT * FROM pub_accounts WHERE id = ?").get(a.id) as any;
  const issues = validatePublication({ network: "reddit", project: a.project, text: "Bonjour", title: "" }, acc());
  assert.ok(issues.some((m) => /Subreddit/.test(m)) && issues.some((m) => /Titre requis pour Reddit/.test(m)), issues.join(" | "));
  assert.throws(() => setAccountTarget(a.id, "r/no"), /invalide/);
  assert.equal((setAccountTarget(a.id, "r/entrepreneur") as any).target, "entrepreneur");
  assert.ok(!validatePublication({ network: "reddit", project: a.project, text: "Bonjour", title: "Titre" }, acc()).some((m) => /Subreddit/.test(m)));
});
