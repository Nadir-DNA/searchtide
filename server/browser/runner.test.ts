// B3 : exécution navigateur sur page de test — preuve, contenu lié à l'approbation, états d'arrêt, incertitude.
process.env.SECRET = "s".repeat(40);
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { db } from "../db.ts";
import { saveProject } from "../projects.ts";
import { savePublication } from "../business.ts";
import { createAccount } from "../publishers/queue.ts";
import { createApproval, decideApproval, verifyApproval } from "../approvals.ts";
import { startFixtures } from "./fixtures.ts";
import { publicationBinding, publishWithBrowser } from "./runner.ts";

const TODAY = new Date().toISOString().slice(0, 10);
const mediaDir = join(tmpdir(), `st-runner-${process.pid}`);
process.env.MEDIA_DIR = mediaDir;

function setup(text = "Bonjour") {
  const project = saveProject(null, { name: `Web ${Math.random().toString(36).slice(2, 7)}`, crm_key: `proj-web-${Math.random().toString(36).slice(2, 8)}` })!;
  const account = createAccount({ project: String(project.crm_key), network: "x", label: "Compte web" }) as Record<string, any>;
  const pub = savePublication(null, { day: TODAY, title: "Annonce web", project: String(project.crm_key), network: "x", status: "scheduled", text, account_id: account.id }) as Record<string, any>;
  db.prepare("UPDATE publications SET state = 'scheduled', scheduled_at = ? WHERE id = ?").run(Date.now(), pub.id);
  return { projectId: String(project.id), projectKey: String(project.crm_key), account, pubId: String(pub.id) };
}
const pub = (id: string) => db.prepare("SELECT * FROM publications WHERE id = ?").get(id) as Record<string, any>;
function approval(s: ReturnType<typeof setup>, text?: string) {
  const p = pub(s.pubId);
  const a = createApproval("agent-web", { action: "publication_publish", project_id: s.projectId, target_id: s.pubId, payload: publicationBinding({ ...p, text: text ?? p.text }) });
  decideApproval(a.id, "approved");
  return a.id;
}

test("B3 : succès avec preuve, approbation à usage unique, contenu modifié refusé", async () => {
  const f = await startFixtures();
  try {
    const s = setup("Contenu approuvé");
    const id = approval(s);
    const run = (approvalId: string) => publishWithBrowser({ publication: pub(s.pubId), account: s.account, approvalId, agentId: "agent-web", baseUrl: f.url, fixturePort: f.port, sandbox: false, entry: "/composer", proofTimeoutMs: 5_000 });
    const ok = await run(id);
    assert.equal(ok.state, "published");
    assert.match(String(ok.proof), /^https:\/\/exemple\.test\/posts\//);
    assert.ok(ok.screenshot && existsSync(ok.screenshot), "capture de preuve conservée");
    assert.equal((await run(id)).state, "failed", "approbation rejouée refusée");

    // Approbation liée au contenu : modifier le texte après coup la refuse avant navigation.
    const s2 = setup("Texte A");
    const id2 = approval(s2, "Texte A");
    db.prepare("UPDATE publications SET text = 'Texte B' WHERE id = ?").run(s2.pubId);
    const changed = await publishWithBrowser({ publication: pub(s2.pubId), account: s2.account, approvalId: id2, agentId: "agent-web", baseUrl: f.url, fixturePort: f.port, sandbox: false });
    assert.equal(changed.state, "failed");
    assert.match(String(changed.message), /Contenu modifié/);
  } finally { await f.close(); rmSync(mediaDir, { recursive: true, force: true }); }
});

test("B3 : connexion demandée = action requise sans consommer ; sans preuve ou page perdue = à vérifier", async () => {
  const f = await startFixtures();
  try {
    const s = setup();
    db.prepare("UPDATE publications SET text = 'Bonjour' WHERE id = ?").run(s.pubId);
    const id = approval(s);
    const login = await publishWithBrowser({ publication: pub(s.pubId), account: s.account, approvalId: id, agentId: "agent-web", baseUrl: f.url, fixturePort: f.port, sandbox: false, entry: "/login" });
    assert.equal(login.state, "action_required");
    assert.equal(verifyApproval(id, { agentId: "agent-web", action: "publication_publish", projectId: s.projectId, targetId: s.pubId, payload: publicationBinding(pub(s.pubId)) }), "ok", "aucune consommation avant le clic");

    const id2 = approval(s);
    const noProof = await publishWithBrowser({ publication: pub(s.pubId), account: s.account, approvalId: id2, agentId: "agent-web", baseUrl: f.url, fixturePort: f.port, sandbox: false, entry: "/composer-no-proof", proofTimeoutMs: 700 });
    assert.equal(noProof.state, "to_verify");

    const s2 = setup();
    const id3 = approval(s2);
    const crash = await publishWithBrowser({ publication: pub(s2.pubId), account: s2.account, approvalId: id3, agentId: "agent-web", baseUrl: f.url, fixturePort: f.port, sandbox: false, entry: "/composer-crash", proofTimeoutMs: 700 });
    assert.equal(crash.state, "to_verify");
  } finally { await f.close(); rmSync(mediaDir, { recursive: true, force: true }); }
});
