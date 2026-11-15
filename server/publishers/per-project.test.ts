// Un calendrier et des comptes par projet : filtres par identifiant ou clé CRM, compte connecté par OAuth (identifiant) valable
// pour une publication enregistrée avec la clé CRM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../db.ts";
import { listPublications, savePublication } from "../business.ts";
import { createAccount, createConnectedAccount, listAccounts, validatePublication } from "./queue.ts";

db.prepare("INSERT INTO projects (id, name, crm_key, created_at) VALUES ('id-a', 'Projet A', 'cle-a', 0), ('id-b', 'Projet B', 'cle-b', 0)").run();
const day = new Date().toISOString().slice(0, 10);

test("publications et comptes filtrés par projet, quelle que soit la clé utilisée", () => {
  savePublication(null, { day, title: "A1", project: "cle-a", network: "x" });
  savePublication(null, { day, title: "A2", project: "id-a", network: "x" });
  savePublication(null, { day, title: "B1", project: "cle-b", network: "x" });
  for (const k of ["id-a", "cle-a"]) assert.deepEqual((listPublications({ project: k }) as any[]).map((p) => p.title).sort(), ["A1", "A2"], k);
  createAccount({ project: "cle-a", network: "x", label: "X de A" });
  createConnectedAccount({ project: "id-a", network: "linkedin", label: "LinkedIn de A", connection_id: "c1" });
  createAccount({ project: "cle-b", network: "x", label: "X de B" });
  for (const k of ["id-a", "cle-a"]) assert.deepEqual(listAccounts(k).map((a) => a.label).sort(), ["LinkedIn de A", "X de A"], k);
});

test("compte OAuth (identifiant du projet) accepté pour une publication portant la clé CRM ; un autre projet refusé", () => {
  const acc = db.prepare("SELECT * FROM pub_accounts WHERE label = 'X de A'").get() as any;
  db.prepare("UPDATE pub_accounts SET project = 'id-a' WHERE id = ?").run(acc.id);
  const a = db.prepare("SELECT * FROM pub_accounts WHERE id = ?").get(acc.id) as any;
  assert.ok(!validatePublication({ network: "x", project: "cle-a", text: "Bonjour" }, a).some((m) => /n'appartient pas/.test(m)));
  assert.ok(validatePublication({ network: "x", project: "cle-b", text: "Bonjour" }, a).some((m) => /n'appartient pas/.test(m)));
});
