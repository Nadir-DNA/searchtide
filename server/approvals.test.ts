// L1 tranche 2 : approbations génériques, admin seul, hachage lié, usage unique atomique, plafond.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { login, startServer, tempDb } from "./test-server.ts";

test("L1 : approbation — hachage, admin seul, concurrence, plafond", async () => {
  const t = tempDb();
  const s = await startServer(t.path);
  try {
    const cookie = await login(s.base);
    const admin = { Cookie: cookie, "content-type": "application/json" };
    const p = await (await fetch(`${s.base}/api/projects`, { method: "POST", headers: admin, body: JSON.stringify({ name: "A" }) })).json();
    const key = await (await fetch(`${s.base}/api/agents`, { method: "POST", headers: admin, body: JSON.stringify({ name: "agent", read_only: false, projects: [p.id] }) })).json();
    const k = { Authorization: `Bearer ${key.key}`, "content-type": "application/json" };
    const ask = async (payload: unknown) => (await fetch(`${s.base}/api/approvals`, { method: "POST", headers: k, body: JSON.stringify({ action: "test_action", project_id: p.id, payload, before: { source: "manual" }, after: { source: "http" } }) })).json();
    const a = await ask({ source: "manual" });
    assert.equal(a.duplicate, false);
    assert.equal((await fetch(`${s.base}/api/approvals/${a.id}/approve`, { method: "POST", headers: k })).status, 403, "une clé n'approuve pas");
    assert.equal((await fetch(`${s.base}/api/approvals/${a.id}/approve`, { method: "POST", headers: admin })).status, 200);
    const secretPayload = { action: "test_action", project_id: p.id, payload: { url: "https://x.test", apiKey: "hunter2", token: "jeton-secret", password: "motdepasse", keyword: "mot" } };
    const sreq = await (await fetch(`${s.base}/api/approvals`, { method: "POST", headers: k, body: JSON.stringify(secretPayload) })).json();
    const sList = JSON.stringify(await (await fetch(`${s.base}/api/approvals`, { headers: admin })).json());
    assert.doesNotMatch(sList, /hunter2|jeton-secret|motdepasse/, "valeurs sensibles absentes");
    const sp = JSON.parse((await (await fetch(`${s.base}/api/approvals`, { headers: admin })).json()).find((x: any) => x.id === sreq.id).payload);
    assert.deepEqual([sp.apiKey, sp.token, sp.password], ["•••", "•••", "•••"]);
    assert.equal(sp.keyword, "mot", "keyword non masqué");
    const nestedReq = await (await fetch(`${s.base}/api/approvals`, { method: "POST", headers: k, body: JSON.stringify({ action: "test_action", project_id: p.id, payload: { config: { apiKey: "nested-hunter2", nested: { authorization: "Bearer nested-auth", keyword: "garde" } }, url: "https://x.test" } }) })).json();
    const nestedList = JSON.stringify(await (await fetch(`${s.base}/api/approvals`, { headers: admin })).json());
    assert.doesNotMatch(nestedList, /nested-hunter2|nested-auth/, "secrets imbriqués absents");
    const np = JSON.parse((await (await fetch(`${s.base}/api/approvals`, { headers: admin })).json()).find((x: any) => x.id === nestedReq.id).payload);
    assert.deepEqual([np.config.apiKey, np.config.nested.authorization], ["•••", "•••"]);
    assert.equal(np.config.nested.keyword, "garde", "clé non sensible préservée");
    assert.equal(np.url, "https://x.test", "valeur non sensible préservée");
    const refused = await fetch(`${s.base}/api/approvals`, { method: "POST", headers: k, body: JSON.stringify({ action: "indicator_source", project_id: p.id, target_id: "i-inexistant", payload: { config: { password: "hunter2" } } }) });
    assert.equal(refused.status, 400, "secret littéral refusé à la création");
    assert.match((await refused.json()).error, /variable d'environnement/);
    for (let i = 0; i < 20; i++) await ask({ n: i });
    assert.equal((await fetch(`${s.base}/api/approvals`, { method: "POST", headers: k, body: JSON.stringify({ action: "x", project_id: p.id, payload: { n: 99 } }) })).status, 400, "plafond 20");
    const other = await (await fetch(`${s.base}/api/agents`, { method: "POST", headers: admin, body: JSON.stringify({ name: "autre", projects: [p.id] }) })).json();
    const list = await (await fetch(`${s.base}/api/approvals`, { headers: { Authorization: `Bearer ${other.key}` } })).json();
    assert.equal(list.length, 0, "une clé ne voit pas les demandes des autres");
    const adminList = await (await fetch(`${s.base}/api/approvals`, { headers: admin })).json();
    assert.ok(adminList.length >= 1);
    assert.ok(adminList.every((x: any) => !JSON.stringify(x).includes(key.key)));
  } finally { s.stop(); t.done(); }
});

test("L1 : consommation liée à agent/action/projet, atomique", async () => {
  await import("./projects.ts");
  const { createApproval, decideApproval, consumeApproval } = await import("./approvals.ts");
  const { db } = await import("./db.ts");
  db.prepare("DELETE FROM projects WHERE id = 'p-cons'").run();
  db.prepare("DELETE FROM agent_keys WHERE id = 'a1'").run();
  db.prepare("INSERT INTO projects (id, name, position, created_at) VALUES ('p-cons', 'C', 0, 0)").run();
  db.prepare("INSERT INTO agent_keys (id, name, hash, read_only, all_projects, created_at) VALUES ('a1', 'a1', 'h1', 0, 1, 0)").run();
  const a = createApproval("a1", { action: "change_source", project_id: "p-cons", payload: { source: "http" } });
  decideApproval(a.id, "approved");
  const opts = { agentId: "a1", action: "change_source", projectId: "p-cons", targetId: null, payload: { source: "http" } };
  assert.equal(consumeApproval(a.id, { ...opts, action: "autre" }), "hash");
  assert.equal(consumeApproval(a.id, { ...opts, projectId: "autre" }), "hash");
  assert.equal(consumeApproval(a.id, { ...opts, agentId: "autre" }), "hash");
  assert.equal(consumeApproval(a.id, opts), "ok");
  assert.equal(consumeApproval(a.id, opts), "state");
});

test("L1 : changement de source gardé par approbation, transaction et révocation", async () => {
  const t = tempDb();
  const s = await startServer(t.path);
  try {
    const cookie = await login(s.base);
    const admin = { Cookie: cookie, "content-type": "application/json" };
    const p = await (await fetch(`${s.base}/api/projects`, { method: "POST", headers: admin, body: JSON.stringify({ name: "Garde" }) })).json();
    const ind = await (await fetch(`${s.base}/api/projects/${p.id}/indicators`, { method: "POST", headers: admin, body: JSON.stringify({ label: "V", mode: "daily", source: "manual" }) })).json();
    const a = await (await fetch(`${s.base}/api/agents`, { method: "POST", headers: admin, body: JSON.stringify({ name: "g", read_only: false, projects: [p.id] }) })).json();
    const k = { Authorization: `Bearer ${a.key}`, "content-type": "application/json" };
    const body = { source: "site", config: { domain: "garde.test", metric: "visitors" } };
    const badMerge = await fetch(`${s.base}/api/approvals`, { method: "POST", headers: k, body: JSON.stringify({ action: "indicator_source", project_id: p.id, target_id: ind.id, payload: { config: { foo: "bar" } } }) });
    assert.equal(badMerge.status, 400, "charge fusionnée invalide refusée");
    const noUrl = await fetch(`${s.base}/api/approvals`, { method: "POST", headers: k, body: JSON.stringify({ action: "indicator_source", project_id: p.id, target_id: ind.id, payload: { source: "http", config: { path: "v" } } }) });
    assert.equal(noUrl.status, 400, "http sans url refusé");

    const patch = (headers: Record<string, string>, data = body) => fetch(`${s.base}/api/indicators/${ind.id}`, { method: "PATCH", headers: { ...k, ...headers }, body: JSON.stringify(data) });
    assert.equal((await patch({})).status, 403, "sans approbation");
    const req = await (await fetch(`${s.base}/api/approvals`, { method: "POST", headers: k, body: JSON.stringify({ action: "indicator_source", project_id: p.id, target_id: ind.id, payload: body, before: { source: "mensonge" }, after: { source: "mensonge" } }) })).json();
    assert.equal((await patch({ "x-approval-id": req.id })).status, 409, "non approuvée");
    const listed = await (await fetch(`${s.base}/api/approvals`, { headers: admin })).json();
    const item = listed.find((x: any) => x.id === req.id);
    assert.equal(JSON.parse(item.before).source, "manual", "avant calculé serveur");
    assert.equal(JSON.parse(item.after).source, "site", "après calculé serveur");
    assert.equal((await fetch(`${s.base}/api/approvals/${req.id}/approve`, { method: "POST", headers: admin })).status, 200);
    assert.equal((await patch({ "x-approval-id": req.id }, { ...body, config: { ...body.config, metric: "pageviews" } })).status, 409, "charge modifiée");
    assert.equal((await patch({ "x-approval-id": req.id })).status, 200);
    const project = await (await fetch(`${s.base}/api/projects/${p.id}`, { headers: admin })).json();
    assert.equal(project.indicators[0].source, "site", "écriture appliquée");
    const list = await (await fetch(`${s.base}/api/approvals`, { headers: admin })).json();
    assert.equal(list.find((x: any) => x.id === req.id).state, "consumed");
    // Portée retirée entre approbation et exécution : 404, demande non consommée.
    const req2 = await (await fetch(`${s.base}/api/approvals`, { method: "POST", headers: k, body: JSON.stringify({ action: "indicator_source", project_id: p.id, target_id: ind.id, payload: { source: "site", config: { domain: "a.test", metric: "visitors" } } }) })).json();
    await fetch(`${s.base}/api/approvals/${req2.id}/approve`, { method: "POST", headers: admin });
    await fetch(`${s.base}/api/agents/${a.id}/scopes`, { method: "PUT", headers: admin, body: JSON.stringify({ projects: [] }) });
    assert.equal((await patch({ "x-approval-id": req2.id }, { source: "site", config: { domain: "a.test", metric: "visitors" } })).status, 404);
    const after = await (await fetch(`${s.base}/api/approvals`, { headers: admin })).json();
    assert.equal(after.find((x: any) => x.id === req2.id).state, "approved", "non consommée");
  } finally { s.stop(); t.done(); }
});

test("L1 : suppression d'indicateur gardée par approbation, usage unique, lecture seule refusée", async () => {
  const t = tempDb();
  const s = await startServer(t.path);
  try {
    const cookie = await login(s.base);
    const admin = { Cookie: cookie, "content-type": "application/json" };
    const p = await (await fetch(`${s.base}/api/projects`, { method: "POST", headers: admin, body: JSON.stringify({ name: "Suppression" }) })).json();
    const ind = await (await fetch(`${s.base}/api/projects/${p.id}/indicators`, { method: "POST", headers: admin, body: JSON.stringify({ label: "À supprimer", mode: "total", source: "manual", config: { role: "revenue" } }) })).json();
    const key = await (await fetch(`${s.base}/api/agents`, { method: "POST", headers: admin, body: JSON.stringify({ name: "suppr", read_only: false, projects: [p.id] }) })).json();
    const k = { Authorization: `Bearer ${key.key}`, "content-type": "application/json" };

    assert.equal((await fetch(`${s.base}/api/indicators/${ind.id}`, { method: "DELETE", headers: k })).status, 403, "sans approbation : refusé");
    const asked = await fetch(`${s.base}/api/approvals`, { method: "POST", headers: k, body: JSON.stringify({ action: "indicator_delete", project_id: p.id, target_id: ind.id, payload: {} }) });
    assert.equal(asked.status, 201);
    const req = await asked.json();
    const listed = await (await fetch(`${s.base}/api/approvals`, { headers: admin })).json();
    const item = listed.find((x: any) => x.id === req.id);
    assert.equal(item.target_label, "À supprimer", "cible lisible");
    assert.equal(JSON.parse(item.before).label, "À supprimer", "avant = ce qui sera supprimé");
    assert.equal(item.after, "null");

    assert.equal((await fetch(`${s.base}/api/approvals/${req.id}/approve`, { method: "POST", headers: admin })).status, 200);
    assert.equal((await fetch(`${s.base}/api/indicators/${ind.id}`, { method: "DELETE", headers: { ...k, "x-approval-id": req.id } })).status, 200);
    const after = await (await fetch(`${s.base}/api/projects/${p.id}`, { headers: admin })).json();
    assert.equal(after.indicators.length, 0, "indicateur supprimé");
    assert.equal((await fetch(`${s.base}/api/indicators/${ind.id}`, { method: "DELETE", headers: { ...k, "x-approval-id": req.id } })).status, 404, "usage unique");

    // Une clé en lecture seule ne supprime jamais, même avec une approbation accordée.
    const ro = await (await fetch(`${s.base}/api/agents`, { method: "POST", headers: admin, body: JSON.stringify({ name: "suppr-ro", read_only: true, projects: [p.id] }) })).json();
    const ind2 = await (await fetch(`${s.base}/api/projects/${p.id}/indicators`, { method: "POST", headers: admin, body: JSON.stringify({ label: "Garde lecture", mode: "total", source: "manual", config: { role: "revenue" } }) })).json();
    const rok = { Authorization: `Bearer ${ro.key}`, "content-type": "application/json" };
    const req2 = await (await fetch(`${s.base}/api/approvals`, { method: "POST", headers: rok, body: JSON.stringify({ action: "indicator_delete", project_id: p.id, target_id: ind2.id, payload: {} }) })).json();
    await fetch(`${s.base}/api/approvals/${req2.id}/approve`, { method: "POST", headers: admin });
    assert.equal((await fetch(`${s.base}/api/indicators/${ind2.id}`, { method: "DELETE", headers: { ...rok, "x-approval-id": req2.id } })).status, 403);
    assert.equal((await (await fetch(`${s.base}/api/projects/${p.id}`, { headers: admin })).json()).indicators.length, 1, "toujours là");
  } finally { s.stop(); t.done(); }
});

test("L1 : aperçu = écriture — remplacement de config, champs retirés visibles, source inconnue refusée", async () => {
  const t = tempDb();
  const s = await startServer(t.path);
  try {
    const cookie = await login(s.base);
    const admin = { Cookie: cookie, "content-type": "application/json" };
    const p = await (await fetch(`${s.base}/api/projects`, { method: "POST", headers: admin, body: JSON.stringify({ name: "Aperçu" }) })).json();
    const ind = await (await fetch(`${s.base}/api/projects/${p.id}/indicators`, { method: "POST", headers: admin, body: JSON.stringify({ label: "HTTP", mode: "daily", source: "http", config: { url: "https://cur.test/a", path: "v.total", env: "MON_JETON" } }) })).json();
    const key = await (await fetch(`${s.base}/api/agents`, { method: "POST", headers: admin, body: JSON.stringify({ name: "apercu", read_only: false, projects: [p.id] }) })).json();
    const k = { Authorization: `Bearer ${key.key}`, "content-type": "application/json" };
    const ask = async (payload: unknown) => fetch(`${s.base}/api/approvals`, { method: "POST", headers: k, body: JSON.stringify({ action: "indicator_source", project_id: p.id, target_id: ind.id, payload }) });

    // 1. Patch partiel : l'aperçu montre le remplacement exact, y compris path vidé et env retiré.
    const payload = { config: { url: "https://new.test/x" } };
    const asked = await ask(payload);
    assert.equal(asked.status, 201, await asked.clone().text());
    const req = await asked.json();
    const item = (await (await fetch(`${s.base}/api/approvals`, { headers: admin })).json()).find((x: any) => x.id === req.id);
    const before = JSON.parse(item.before), after = JSON.parse(item.after);
    assert.equal(after.config.path, "", "path remis au défaut, comme saveIndicator");
    assert.equal("env" in after.config, false, "env retiré dans l'aperçu");
    assert.equal(before.config.env, "MON_JETON");
    assert.deepEqual(item.removed, ["env"], "les champs retirés sont visibles");
    assert.equal((await fetch(`${s.base}/api/approvals/${req.id}/approve`, { method: "POST", headers: admin })).status, 200);
    const written = await fetch(`${s.base}/api/indicators/${ind.id}`, { method: "PATCH", headers: { ...k, "x-approval-id": req.id }, body: JSON.stringify(payload) });
    assert.equal(written.status, 200);
    const project = await (await fetch(`${s.base}/api/projects/${p.id}`, { headers: admin })).json();
    assert.deepEqual(project.indicators[0].config, after.config, "la config écrite est identique à l'aperçu");

    // 2. Un patch partiel invalide est refusé à la création, pas après approbation.
    assert.equal((await ask({ config: { path: "autre" } })).status, 400, "http sans url : 400");
    // 3. Changement de source avec une config complète : aperçu sans fusion.
    const manual = await ask({ source: "manual", config: { role: "revenue" } });
    assert.equal(manual.status, 201);
    const mreq = await manual.json();
    const mitem = (await (await fetch(`${s.base}/api/approvals`, { headers: admin })).json()).find((x: any) => x.id === mreq.id);
    assert.deepEqual(JSON.parse(mitem.after), { source: "manual", config: { role: "revenue" } });
    // 4. Source inconnue : message clair, pas d'erreur interne.
    const nope = await ask({ source: "nope" });
    assert.equal(nope.status, 400);
    assert.match((await nope.json()).error, /Source inconnue : nope/);
  } finally { s.stop(); t.done(); }
});

test("J2 : suppression d'un projet gardée par approbation, portée revérifiée, usage unique", async () => {
  const t = tempDb();
  const s = await startServer(t.path);
  try {
    const cookie = await login(s.base);
    const admin = { Cookie: cookie, "content-type": "application/json" };
    const p = await (await fetch(`${s.base}/api/projects`, { method: "POST", headers: admin, body: JSON.stringify({ name: "Projet à supprimer" }) })).json();
    const other = await (await fetch(`${s.base}/api/projects`, { method: "POST", headers: admin, body: JSON.stringify({ name: "Projet témoin" }) })).json();
    const key = await (await fetch(`${s.base}/api/agents`, { method: "POST", headers: admin, body: JSON.stringify({ name: "suppr-projet", read_only: false, projects: [p.id] }) })).json();
    const k = { Authorization: `Bearer ${key.key}`, "content-type": "application/json" };

    assert.equal((await fetch(`${s.base}/api/projects/${p.id}`, { method: "DELETE", headers: k })).status, 403, "sans approbation : refusé");
    const asked = await fetch(`${s.base}/api/approvals`, { method: "POST", headers: k, body: JSON.stringify({ action: "project_delete", project_id: p.id, target_id: p.id, payload: {} }) });
    assert.equal(asked.status, 201);
    const req = await asked.json();
    const item = (await (await fetch(`${s.base}/api/approvals`, { headers: admin })).json()).find((x: any) => x.id === req.id);
    assert.equal(JSON.parse(item.before).name, "Projet à supprimer");

    // Une autre cible approuvée ne permet pas de supprimer un projet hors portée.
    assert.equal((await fetch(`${s.base}/api/approvals/${req.id}/approve`, { method: "POST", headers: admin })).status, 200);
    assert.equal((await fetch(`${s.base}/api/projects/${other.id}`, { method: "DELETE", headers: { ...k, "x-approval-id": req.id } })).status, 404);
    assert.equal((await fetch(`${s.base}/api/projects/${p.id}`, { method: "DELETE", headers: { ...k, "x-approval-id": req.id } })).status, 200);
    const snaps = readdirSync(join(t.dir, "backups")).filter((f) => f.startsWith("pre-suppression-"));
    assert.equal(snaps.length, 1, "instantané pris avant la suppression (la tentative hors portée n'en prend pas)");
    const snap = new DatabaseSync(join(t.dir, "backups", snaps[0]));
    assert.equal((snap.prepare("SELECT COUNT(*) c FROM projects WHERE id = ?").get(p.id) as any).c, 1, "l'instantané contient encore le projet");
    snap.close();
    assert.equal((await fetch(`${s.base}/api/projects/${p.id}`, { headers: admin })).status, 404, "projet supprimé");
    assert.equal((await fetch(`${s.base}/api/projects/${other.id}`, { headers: admin })).status, 200, "témoin intact");
    assert.equal((await fetch(`${s.base}/api/projects/${p.id}`, { method: "DELETE", headers: { ...k, "x-approval-id": req.id } })).status, 404, "usage unique et cible absente");
  } finally { s.stop(); t.done(); }
});
