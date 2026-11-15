// D12, variante sans recette : compte « agent » — la publication attend l'agent, l'adresse du post sur le bon réseau fait la preuve.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../db.ts";
import { savePublication } from "../business.ts";
import { createAccount, getPublication, markAgentPublished, queuePublication } from "./queue.ts";
import { agentQueue, proofAccepted } from "./agent-mode.ts";
import { recipeFor, recipes } from "../browser/recipes.ts";
import "./followups.ts";
import { followupsOf, setFollowups } from "./followups.ts";

const uniq = () => `ag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

test("preuve : https sur le domaine du réseau seulement", () => {
  assert.ok(proofAccepted("instagram", "https://www.instagram.com/p/Cx1/"));
  assert.ok(!proofAccepted("instagram", "http://www.instagram.com/p/Cx1/"));
  assert.ok(!proofAccepted("instagram", "https://instagram.com.evil.test/p/1"));
  assert.ok(!proofAccepted("linkedin", "https://x.com/i/status/1"));
});

test("compte agent : à l'heure prévue « action requise », listé pour l'agent, puis publié avec l'adresse du post (suites planifiées)", async () => {
  const project = uniq();
  db.prepare("INSERT INTO projects (id, name, crm_key, created_at) VALUES (?, ?, ?, 0)").run(`id-${project}`, project, project);
  const a = createAccount({ project, network: "instagram", label: "Insta perso", mode: "agent" }) as any;
  assert.equal(a.mode, "agent");
  const p = savePublication(null, { day: new Date().toISOString().slice(0, 10), title: "Nouveauté", project, network: "instagram", text: "Notre nouvelle lampe" }) as any;
  db.prepare("UPDATE publications SET account_id = ? WHERE id = ?").run(a.id, p.id);
  setFollowups(p.id, { first_comment: "Lien en bio" });
  await queuePublication(p.id, { now: true });
  assert.equal(getPublication(p.id)!.state, "needs_action");
  const q = agentQueue(project);
  assert.equal(q.length, 1); assert.equal(q[0].text, "Notre nouvelle lampe"); assert.match(q[0].instructions, /pub_report_published/);
  assert.equal(q[0].first_comment, "Lien en bio");
  assert.throws(() => markAgentPublished(p.id, "https://x.com/i/status/1", "Claude"), /Adresse refusée/);
  const done = markAgentPublished(p.id, "https://www.instagram.com/p/Cx1/", "Claude dans Chrome")!;
  assert.equal(done.state, "published"); assert.equal(done.evidence_url, "https://www.instagram.com/p/Cx1/");
  assert.deepEqual(agentQueue(project), []);
  assert.equal((followupsOf(p.id) as any[]).length, 1, "le premier commentaire est planifié comme pour un envoi API");
  assert.throws(() => markAgentPublished(p.id, "https://www.instagram.com/p/Cx2/", "Claude"), /en attente/);
});

test("recettes : les réseaux visés en ont une, avec médias et cible quand il le faut", () => {
  for (const n of ["x", "linkedin", "facebook", "instagram", "tiktok", "youtube", "pinterest", "reddit"]) assert.ok(recipeFor(n), n);
  assert.equal(recipeFor("gbp"), undefined);
  assert.ok(recipes().find((r) => r.network === "instagram")!.requiresMedia);
  assert.ok(recipeFor("reddit")!.requiresTarget && recipeFor("reddit")!.entry.includes("{target}"));
  assert.equal(recipeFor("youtube")!.proof?.mustInclude, "youtu");
});
