// D12 : repli par le navigateur intégré — seulement après un échec certain de l'API, sur un compte qui l'a activé,
// avec une recette pour le réseau et une session enregistrée. Jamais sur un doute.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../db.ts";
import { savePublication } from "../business.ts";
import { accountBelongsToProject, createAccount, getPublication, queuePublication, setBrowserFallback, shouldFallback } from "./queue.ts";
import { recipeFor, recipes } from "../browser/recipes.ts";

const uniq = () => `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const acc = { browser_fallback: 1 };

test("décision : jeton refusé, quota ou limite → repli ; doute, refus du contenu ou format → jamais", () => {
  for (const kind of ["auth", "quota", "rate"] as const) assert.equal(shouldFallback({ ok: false, kind, message: "" }, acc, true, true), true, kind);
  for (const kind of ["to_verify", "pending", "refused", "format", "network", "unknown"] as const)
    assert.equal(shouldFallback({ ok: false, kind, message: "", data: {} } as any, acc, true, true), false, kind);
  assert.equal(shouldFallback({ ok: true, url: "https://x" }, acc, true, true), false);
  assert.equal(shouldFallback({ ok: false, kind: "auth", message: "" }, { browser_fallback: 0 }, true, true), false, "repli non activé");
  assert.equal(shouldFallback({ ok: false, kind: "auth", message: "" }, acc, false, true), false, "pas de recette");
  assert.equal(shouldFallback({ ok: false, kind: "auth", message: "" }, acc, true, false), false, "pas de session");
});

test("activation : réseaux avec recette seulement ; le compte peut alors recevoir une session navigateur", () => {
  const project = uniq();
  db.prepare("INSERT INTO projects (id, name, crm_key, created_at) VALUES (?, ?, ?, 0)").run(`id-${project}`, project, project);
  const x = createAccount({ project, network: "x", label: "X" }) as any;
  const yt = createAccount({ project, network: "gbp", label: "Fiche" }) as any;
  assert.equal(accountBelongsToProject(x.id, project), false, "compte API sans repli : pas de session navigateur");
  assert.equal((setBrowserFallback(x.id, true) as any).browser_fallback, 1);
  assert.equal(accountBelongsToProject(x.id, project), true);
  assert.throws(() => setBrowserFallback(yt.id, true), /Pas de recette navigateur pour gbp/);
  assert.deepEqual(recipes().map((r) => r.network).sort(), ["facebook", "instagram", "linkedin", "pinterest", "reddit", "tiktok", "x", "youtube"]);
  assert.equal(recipeFor("x")!.validated, null, "recette non éprouvée tant qu'elle n'a pas été validée sur un vrai compte");
});

test("compte réel au jeton refusé, repli activé mais aucune session : action requise, rien n'est tenté", async () => {
  const project = uniq();
  db.prepare("INSERT INTO projects (id, name, crm_key, created_at) VALUES (?, ?, ?, 0)").run(`id-${project}`, project, project);
  const a = createAccount({ project, network: "x", label: "X réel" }) as any;
  db.prepare("UPDATE pub_accounts SET connection_id = 'connexion-absente', browser_fallback = 1 WHERE id = ?").run(a.id);
  const p = savePublication(null, { day: new Date().toISOString().slice(0, 10), title: "T", project, network: "x", text: "Bonjour" }) as any;
  await queuePublication(p.id, { now: true, account_id: a.id, text: "Bonjour" });
  const after = getPublication(p.id)!;
  assert.equal(after.state, "needs_action");
  const attempts = db.prepare("SELECT detail FROM pub_attempts WHERE publication_id = ? ORDER BY id").all(p.id) as { detail: string }[];
  assert.ok(!attempts.some((x) => /repli/.test(x.detail)), "pas de repli sans session enregistrée");
});
