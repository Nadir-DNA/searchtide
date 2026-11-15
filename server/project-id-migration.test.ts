import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db.ts";
import { createContact, savePublication, migrateProjectIds } from "./business.ts";
import { migrateAccountProjects } from "./publishers/queue.ts";

// C3 : la migration réécrit les anciennes clés et les noms de projet vers l'identifiant,
// garde les valeurs inconnues telles quelles et ne touche pas à celles déjà correctes.
test("migration projet : clé CRM, nom, identifiant et texte libre", () => {
  db.exec("DELETE FROM contacts; DELETE FROM publications; DELETE FROM projects;");
  db.prepare("INSERT INTO projects (id, name, crm_key, created_at) VALUES (?, ?, ?, ?)").run("p_fieat", "Fieat", "fieat", 1);
  db.prepare("INSERT INTO projects (id, name, crm_key, created_at) VALUES (?, ?, ?, ?)").run("p_autre", "Autre", null, 2);

  for (const [name, project] of [["cle", "fieat"], ["nom", "Fieat"], ["id", "p_autre"], ["libre", "monprojet"]] as const) {
    createContact({ name, project });
    savePublication(null, { day: "2026-11-15", title: name, project, network: "x" });
  }

  migrateProjectIds();

  const contacts = Object.fromEntries((db.prepare("SELECT name, project FROM contacts").all() as { name: string; project: string }[]).map((r) => [r.name, r.project]));
  const pubs = Object.fromEntries((db.prepare("SELECT title, project FROM publications").all() as { title: string; project: string }[]).map((r) => [r.title, r.project]));

  assert.deepEqual(contacts, { cle: "p_fieat", nom: "p_fieat", id: "p_autre", libre: "monprojet" });
  assert.deepEqual(pubs, { cle: "p_fieat", nom: "p_fieat", id: "p_autre", libre: "monprojet" });

  // Rejouer la migration ne change plus rien.
  migrateProjectIds();
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE project IN ('fieat', 'Fieat')").get() as { n: number }).n, 0);

  // Les comptes de publication suivent la même règle.
  db.prepare("INSERT INTO pub_accounts (id, project, network, label, created_at) VALUES ('acc1', 'fieat', 'x', 'Compte', 1)").run();
  migrateAccountProjects();
  assert.equal((db.prepare("SELECT project FROM pub_accounts WHERE id = 'acc1'").get() as { project: string }).project, "p_fieat");
});
