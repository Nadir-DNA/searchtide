// D2 : variantes par réseau — un texte par compte, vérifié avant l'envoi, une publication par compte reliée par un groupe.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../db.ts";
import { createAccount, getPublication } from "./queue.ts";
import { checkBatch, createBatch } from "./batch.ts";

const TODAY = new Date().toISOString().slice(0, 10);
const uniq = () => `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
function accounts() {
  const project = uniq();
  db.prepare("INSERT INTO projects (id, name, crm_key, created_at) VALUES (?, ?, ?, 0)").run(`id-${project}`, project, project);
  return {
    x: (createAccount({ project, network: "x", label: "X" }) as any).id as string,
    li: (createAccount({ project, network: "linkedin", label: "LinkedIn" }) as any).id as string,
  };
}

test("aperçu : chaque réseau juge son propre texte, rien n'est créé", () => {
  const a = accounts();
  const before = (db.prepare("SELECT COUNT(*) AS n FROM publications").get() as any).n;
  const r = checkBatch({ title: "Lancement", items: [{ account_id: a.x, text: "x".repeat(300) }, { account_id: a.li, text: "x".repeat(300) }] });
  assert.match(r[0].issues.join(), /Texte trop long pour x/);
  assert.deepEqual(r[1].issues, [], "300 caractères passent sur LinkedIn");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM publications").get() as any).n, before);
});

test("création : une publication par compte, même groupe, texte propre à chaque réseau, programmées ensemble", async () => {
  const a = accounts();
  const at = new Date(Date.now() + 3600_000).toISOString();
  const r = await createBatch({ title: "Lancement", day: TODAY, when: "at", at, items: [{ account_id: a.x, text: "Court pour X" }, { account_id: a.li, text: "Version longue pour LinkedIn" }] });
  assert.equal(r.items.length, 2);
  const [px, pli] = r.items.map((i) => getPublication(i.id)!);
  assert.equal(px.network, "x"); assert.equal(px.text, "Court pour X");
  assert.equal(pli.network, "linkedin"); assert.equal(pli.text, "Version longue pour LinkedIn");
  assert.equal(px.group_id, r.group_id); assert.equal(pli.group_id, r.group_id);
  assert.deepEqual(r.items.map((i) => i.state), ["scheduled", "scheduled"]);
});

test("un compte refusé n'empêche pas les autres ; doublon, liste vide et compte inconnu refusés", async () => {
  const a = accounts();
  const at = new Date(Date.now() + 3600_000).toISOString();
  const r = await createBatch({ title: "Mixte", day: TODAY, when: "at", at, items: [{ account_id: a.x, text: "x".repeat(281) }, { account_id: a.li, text: "ok" }] });
  assert.match(r.items[0].error ?? "", /Texte trop long/);
  assert.equal(r.items[0].state, "draft", "reste en brouillon, rien ne part");
  assert.equal(r.items[1].state, "scheduled");
  await assert.rejects(createBatch({ title: "D", day: TODAY, items: [{ account_id: a.x, text: "a" }, { account_id: a.x, text: "b" }] }), /deux fois/);
  await assert.rejects(createBatch({ title: "V", day: TODAY, items: [] }), /au moins un compte/);
  await assert.rejects(createBatch({ title: "I", day: TODAY, items: [{ account_id: "nope", text: "a" }] }), /introuvable/);
});
