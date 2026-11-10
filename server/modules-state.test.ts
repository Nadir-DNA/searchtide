import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db.ts";
import { saveIndicator, saveProject } from "./projects.ts";
import { enabledFor, hiddenIndicators, indicatorModule, isEnabled, projectModuleSettings, setEnabled, setProjectModule } from "./modules/state.ts";

test("état : désactiver un module masque ses indicateurs sans les supprimer", () => {
  const p = saveProject(null, { name: "P" })!;
  const ind = saveIndicator(null, p.id, { label: "MRR", mode: "total", source: "stripe", config: { metric: "mrr", env: "STRIPE_X" } })!;
  setEnabled("stripe", true); setProjectModule(p.id, "stripe", true);
  assert.equal(hiddenIndicators(p.id).has(ind.id), false);
  setProjectModule(p.id, "stripe", false);
  assert.equal(hiddenIndicators(p.id).has(ind.id), true);
  assert.ok(db.prepare("SELECT 1 FROM indicators WHERE id = ?").get(ind.id));
  setProjectModule(p.id, "stripe", true);
  assert.equal(hiddenIndicators(p.id).has(ind.id), false);
});

test("état : désactiver un module pour un projet garde ses réglages", () => {
  const p = saveProject(null, { name: "Q" })!;
  setEnabled("google", true); setProjectModule(p.id, "google", true, { gsc_property: { "q.fr": "sc-domain:q.fr" } });
  setProjectModule(p.id, "google", false);
  assert.equal(enabledFor(p.id, "google"), false);
  setProjectModule(p.id, "google", true);
  assert.deepEqual(projectModuleSettings(p.id, "google"), { gsc_property: { "q.fr": "sc-domain:q.fr" } });
});

test("état : un module cœur est toujours actif et ne se désactive pas", () => {
  assert.equal(isEnabled("analytics"), true);
  assert.throws(() => setEnabled("analytics", false), /cœur/);
});

test("état : un module inactif sur l'instance n'est actif sur aucun projet", () => {
  const p = saveProject(null, { name: "R" })!;
  setProjectModule(p.id, "crm", true);
  assert.equal(enabledFor(p.id, "crm"), false);
});

test("état : source d'indicateur → module", () => {
  assert.equal(indicatorModule({ source: "pg", config: {} }), "produit");
  assert.equal(indicatorModule({ source: "play", config: {} }), "google");
  assert.equal(indicatorModule({ source: "manual", config: {} }), "projets");
  assert.equal(indicatorModule({ source: "stripe", config: {} }), "stripe");
});

test("état : créer un indicateur active son module pour le projet", () => {
  const p = saveProject(null, { name: "S" })!;
  setEnabled("produit", false);
  const ind = saveIndicator(null, p.id, { label: "Inscrits", mode: "daily", source: "http", config: { url: "https://exemple.com/n.json", path: "n" } })!;
  assert.equal(enabledFor(p.id, "produit"), true);
  assert.equal(hiddenIndicators(p.id).has(ind.id), false);
});
