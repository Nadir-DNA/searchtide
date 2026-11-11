// Défauts de la revue Franky : MED-D1 (origine des médias), L2-D1 (édition d'une publication programmée),
// B2-D3/D4 (session sealed et validation du compte), médias verrouillés, dossier vide.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
process.env.SECRET = "s".repeat(40);
import { db } from "../db.ts";
import { savePublication } from "../business.ts";
import { createAccount, deleteAccount } from "./queue.ts";
import { openBrowserSession, saveBrowserSession } from "../browser/live.ts";
import { login, startServer, tempDb } from "../test-server.ts";

const TODAY = new Date().toISOString().slice(0, 10);
const project = (key: string) => db.prepare("INSERT OR IGNORE INTO projects (id, name, crm_key, created_at) VALUES (?, ?, ?, 0)").run(`id-${key}`, key, key);

test("L2-D1 : modifier le contenu d'une publication programmée est refusé ; les notes restent modifiables", () => {
  project("pd1");
  const p = savePublication(null, { day: TODAY, title: "T", project: "pd1", network: "x", status: "scheduled", text: "avant" }) as any;
  db.prepare("UPDATE publications SET state = 'scheduled', scheduled_at = ? WHERE id = ?").run(Date.now() + 60_000, p.id);
  assert.throws(() => savePublication(p.id, { text: "après" }), /annulez-la avant de modifier text/);
  assert.throws(() => savePublication(p.id, { status: "idea" }), /status/);
  const n = savePublication(p.id, { notes: "une note" }) as any;
  assert.equal(n.state, "scheduled", "l'état de file est conservé");
  assert.equal((db.prepare("SELECT text FROM publications WHERE id = ?").get(p.id) as any).text, "avant");
});

test("B2-D3 : supprimer un compte efface sa session scellée ; un compte exige un projet existant", () => {
  assert.throws(() => createAccount({ project: "projet-fantome", network: "x", label: "L" }), /Projet introuvable/);
  project("pd3");
  const a = createAccount({ project: "pd3", network: "x", label: "Web", mode: "web", web_url: "https://exemple.test/login" }) as any;
  saveBrowserSession(a.id, "id-pd3", { cookies: [] });
  assert.ok(openBrowserSession(a.id));
  assert.equal(deleteAccount(a.id), true);
  assert.equal(openBrowserSession(a.id), null);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM browser_sessions WHERE account_id = ?").get(a.id) as any).c, 0);
});

test("L2-D3 : événements de sécurité dédiés pour un compte supprimé", () => {
  project("pd3b");
  const a = createAccount({ project: "pd3b", network: "x", label: "L" }) as any;
  deleteAccount(a.id);
  const k = (db.prepare("SELECT kind FROM security_events ORDER BY id DESC LIMIT 1").get() as any).kind;
  assert.equal(k, "pub_account_deleted");
});

test("MED-D1 + B2-D4 + médias : origine contrôlée, verrou des programmées, dossier vide, close{save} validé", async () => {
  const t = tempDb();
  const media = join(t.dir, "media");
  const s = await startServer(t.path, { MEDIA_DIR: media });
  try {
    const cookie = await login(s.base);
    const J = { Cookie: cookie, "content-type": "application/json" };
    const post = async (path: string, body: unknown) => (await fetch(`${s.base}${path}`, { method: "POST", headers: J, body: JSON.stringify(body) })).json() as Promise<any>;
    const a = await post("/api/projects", { name: "A", crm_key: "ka" });
    const b = await post("/api/projects", { name: "B", crm_key: "kb" });
    const pub = await post("/api/publications", { day: TODAY, title: "P", project: "ka", network: "x", status: "idea" });
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
    const up = (extra: Record<string, string>) => fetch(`${s.base}/api/publications/${pub.id}/media?name=a.png`, { method: "POST", headers: { Cookie: cookie, "content-type": "image/png", ...extra }, body: png });
    assert.equal((await up({ Origin: "https://evil.test" })).status, 403, "Origin étranger");
    assert.equal((await up({ "Sec-Fetch-Site": "cross-site" })).status, 403, "cross-site");
    const ok = await up({ Origin: new URL(s.base).origin });
    assert.equal(ok.status, 201, await ok.clone().text());
    const m = await ok.json();
    // Dossier vide supprimé avec le dernier média.
    assert.equal(existsSync(join(media, pub.id)), true);
    assert.equal((await fetch(`${s.base}/api/publications/${pub.id}/media/${m.id}`, { method: "DELETE", headers: J })).status, 200);
    assert.equal(existsSync(join(media, pub.id)), false, "dossier vide retiré");
    // Verrou : publication programmée.
    const d = new DatabaseSync(t.path); d.prepare("UPDATE publications SET state = 'scheduled' WHERE id = ?").run(pub.id); d.close();
    assert.equal((await up({})).status, 409);
    // B2-D4 : enregistrement de session — compte inexistant, ou compte d'un autre projet = 400.
    const acc = await post("/api/pub-accounts", { project: "ka", network: "x", label: "Web", mode: "web", web_url: "https://exemple.test/login" });
    assert.ok(acc.id, JSON.stringify(acc));
    const close = (body: unknown) => fetch(`${s.base}/api/browser/live/close`, { method: "POST", headers: J, body: JSON.stringify(body) });
    assert.equal((await close({ save: true, account_id: "n-existe-pas", project_id: a.id })).status, 400);
    assert.equal((await close({ save: true, account_id: acc.id, project_id: b.id })).status, 400, "compte de A sous le projet B");
  } finally { s.stop(); t.done(); }
});

test("Idempotence : l'intention est écrite avant l'envoi ; une intention sans adresse = « À vérifier », jamais rejouée", async () => {
  const { publishToNetwork } = await import("./queue.ts");
  const acc = { id: "a", status: "connected" };
  // Plantage après l'intention : l'exception remonte, la trace « url vide » reste.
  await assert.rejects(publishToNetwork({ id: "p1", network: "x", text: "[crash]", idempotency_key: "k-crash" }, acc), /plantage simulé/);
  assert.equal((db.prepare("SELECT url FROM pub_idempotency WHERE key = 'k-crash'").get() as any).url, "");
  // Rejeu avec la même clé : pas d'envoi, « à vérifier ».
  const again = await publishToNetwork({ id: "p1", network: "x", text: "ok", idempotency_key: "k-crash" }, acc);
  assert.deepEqual([again.ok, (again as any).kind], [false, "to_verify"]);
  // Envoi nominal : adresse enregistrée puis rejeu = même adresse.
  const first = await publishToNetwork({ id: "p2", network: "x", text: "ok", idempotency_key: "k-ok" }, acc) as any;
  const second = await publishToNetwork({ id: "p2", network: "x", text: "ok", idempotency_key: "k-ok" }, acc) as any;
  assert.equal(first.url, second.url);
});
