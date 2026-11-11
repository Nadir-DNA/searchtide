// L2 phase 1 : file de publications — validation par réseau, états, preuve, retard, plafond, reprise.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../db.ts";
import { savePublication } from "../business.ts";
import { cancelPublication, createAccount, getPublication, listAccounts, publishToNetwork, queuePublication, recoverInterrupted, retryPublication, runPublicationQueue } from "./queue.ts";

const TODAY = new Date().toISOString().slice(0, 10);
const uniq = () => `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
function pub(project: string, o: Record<string, unknown> = {}) {
  return savePublication(null, { day: TODAY, title: "Annonce de test", project, network: "x", status: "scheduled", ...o }) as Record<string, any>;
}
const account = (project: string, o: Record<string, unknown> = {}) => createAccount({ project, network: "x", label: "Compte test", ...o }) as Record<string, any>;

test("L2 : validation — texte trop long, compte manquant, réseau inconnu refusés avant la file", async () => {
  const project = uniq();
  const account_id = account(project).id;
  const p = pub(project);
  await assert.rejects(queuePublication(p.id, { now: true, account_id, text: "a".repeat(281) }), /Texte trop long pour x/);
  await assert.rejects(queuePublication(p.id, { now: true, account_id: null, text: "ok" }), /Compte de publication requis/);
  const bad = pub(project, { network: "myspace" });
  await assert.rejects(queuePublication(bad.id, { now: true, account_id, text: "ok" }), /Réseau non pris en charge/);
  assert.equal(getPublication(p.id)?.state, "draft", "rien n'est parti");
});

test("L2 : publication immédiate — état publié, preuve, tentative ; plafond quotidien respecté", async () => {
  const project = uniq();
  const account_id = account(project, { daily_cap: 1 }).id;
  const p = pub(project);
  const done = await queuePublication(p.id, { now: true, account_id, text: "Bonjour" });
  assert.equal(done?.state, "published");
  assert.equal(done?.status, "published");
  assert.match(String(done?.evidence_url), /^https:\/\/sim\.test\/x\//);
  const second = pub(project);
  const capped = await queuePublication(second.id, { now: true, account_id, text: "Deuxième" });
  assert.equal(capped?.state, "failed");
  const attempts = (await import("./queue.ts")).attemptsOf(second.id) as any[];
  assert.match(String(attempts[0].detail), /plafond quotidien/);
});

test("L2 : programmation à t+1 min, annulation avant l'heure, retard de 3 h = manqué", async () => {
  const project = uniq();
  const account_id = account(project, { daily_cap: 10 }).id;
  const now = Date.now();
  const p = pub(project);
  await queuePublication(p.id, { at: now + 60_000, account_id, text: "Programmé" });
  assert.equal(getPublication(p.id)?.state, "scheduled");
  await runPublicationQueue(now + 30_000);
  assert.equal(getPublication(p.id)?.state, "scheduled", "pas avant l'heure");
  await runPublicationQueue(now + 60_000);
  assert.equal(getPublication(p.id)?.state, "published", "parti dans la minute");

  const c = pub(project);
  await queuePublication(c.id, { at: now + 60_000, account_id, text: "À annuler" });
  cancelPublication(c.id);
  assert.equal(getPublication(c.id)?.state, "cancelled");
  await runPublicationQueue(now + 120_000);
  assert.equal(getPublication(c.id)?.state, "cancelled", "annulée : jamais envoyée");

  const late = pub(project);
  dbUpdateScheduled(late.id, now - 3 * 60 * 60_000, account_id, "Trop tard");
  await runPublicationQueue(now);
  assert.equal(getPublication(late.id)?.state, "missed");
  assert.equal(getPublication(late.id)?.published_at ?? null, null, "aucune publication");
});

test("L2 : échec classé, reconnexion requise, nouvelle tentative explicite ; redémarrage = à vérifier", async () => {
  const project = uniq();
  const account_id = account(project, { daily_cap: 10 }).id;
  const p = pub(project);
  await queuePublication(p.id, { now: true, account_id, text: "Contenu [fail]" });
  assert.equal(getPublication(p.id)?.state, "failed");
  const retried = await retryPublication(p.id);
  assert.equal(retried?.state, "failed", "le marqueur échoue encore : pas de fausse réussite");

  const expiredAccount = account(project, { label: "Compte expiré" });
  const a = pub(project);
  const now2 = Date.now();
  await queuePublication(a.id, { at: now2 + 60_000, account_id: expiredAccount.id, text: "Connexion" });
  dbExpireAccount(expiredAccount.id);                    // le jeton expire entre la programmation et l'envoi
  await runPublicationQueue(now2 + 60_000);
  assert.equal(getPublication(a.id)?.state, "needs_action");
  dbConnectAccount(expiredAccount.id);
  const ok = await retryPublication(a.id);
  assert.equal(ok?.state, "published");

  // Une publication restée « en cours » au redémarrage n'est jamais relancée.
  const stuck = pub(project);
  dbUpdateState(stuck.id, "running", account_id);
  recoverInterrupted();
  assert.equal(getPublication(stuck.id)?.state, "to_verify");
  await assert.rejects(retryPublication(stuck.id), /Seule une publication en échec/);
});

test("L2 : idempotence — un rejeu du même contenu ne crée pas de doublon", async () => {
  const project = uniq();
  const account_id = account(project).id;
  const p = pub(project);
  const done = await queuePublication(p.id, { now: true, account_id, text: "Même contenu" });
  const firstUrl = done?.evidence_url;
  const row = getPublication(p.id)!;
  const acc = (await import("./queue.ts")).listAccounts(project)[0];
  const replay = await publishToNetwork(row, acc);
  assert.equal(replay.ok, true);
  assert.equal(replay.ok && replay.url, firstUrl, "même adresse, aucun doublon");
  const rows = (await import("../db.ts")).db.prepare("SELECT COUNT(*) AS n FROM pub_idempotency WHERE key = ?").get(String(row.idempotency_key)) as { n: number };
  assert.equal(rows.n, 1);
});

test("L2 : révocation d'un compte annule ses publications programmées", async () => {
  const project = uniq();
  const account_id = account(project).id;
  const p = pub(project);
  await queuePublication(p.id, { at: Date.now() + 60_000, account_id, text: "Programmé" });
  assert.equal(listAccounts(project).length, 1);
  const { deleteAccount } = await import("./queue.ts");
  assert.equal(deleteAccount(account_id), true);
  assert.equal(getPublication(p.id)?.state, "cancelled");
});

// Aides de test : insèrent un état que l'interface ne permet pas.
function dbUpdateScheduled(id: string, at: number, accountId: string, text: string) {
  db.prepare("UPDATE publications SET state = 'scheduled', scheduled_at = ?, account_id = ?, text = ?, status = 'scheduled' WHERE id = ?").run(at, accountId, text, id);
}
function dbUpdateState(id: string, state: string, accountId: string) {
  db.prepare("UPDATE publications SET state = ?, account_id = ? WHERE id = ?").run(state, accountId, id);
}
function dbExpireAccount(id: string) { db.prepare("UPDATE pub_accounts SET status = 'expired' WHERE id = ?").run(id); }
function dbConnectAccount(id: string) { db.prepare("UPDATE pub_accounts SET status = 'connected' WHERE id = ?").run(id); }
