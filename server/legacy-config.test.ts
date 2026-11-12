// SEC-09d : config héritée masquée pour les clés, visible admin, événement sans valeur, rien supprimé.
import { test } from "node:test";
import assert from "node:assert/strict";
import { login, seed, startServer, tempDb } from "./test-server.ts";

test("SEC-09d : config héritée masquée par rôle, admin intact, legacy journalisé", async () => {
  const t = tempDb();
  seed(t.path, `import "@server/projects.ts";
    const { saveProject, saveIndicator } = await import("@server/projects.ts");
    const { db } = await import("@server/db.ts");
    const p = saveProject(null, { name: "Hérité" });
    const i = saveIndicator(null, p.id, { label: "Ancien", mode: "daily", source: "http", config: { url: "https://x.test", path: "v" } });
    db.prepare("UPDATE indicators SET config = ? WHERE id = ?").run(JSON.stringify({ url: "https://x.test", path: "v", password: "ADMIN-PW-1", nested: { authorization: "BR-2" }, liste: [{ secret: "NESTED-9" }] }), i.id);
    console.log(JSON.stringify({ project: p.id, indicator: i.id }));`);
  const s = await startServer(t.path);
  try {
    const admin = { Cookie: await login(s.base) };
    const listAdmin = await (await fetch(`${s.base}/api/projects`, { headers: admin })).json();
    const adminConfig = listAdmin[0].indicators[0].config;
    assert.equal(adminConfig.password, "ADMIN-PW-1", "admin voit la valeur réelle");
    const pid = listAdmin[0].id;
    const agent = await (await fetch(`${s.base}/api/agents`, { method: "POST", headers: { ...admin, "content-type": "application/json" }, body: JSON.stringify({ name: "legacy", projects: [pid] }) })).json();
    const iid = listAdmin[0].indicators[0].id;
    assert.equal((await fetch(`${s.base}/api/indicators/${iid}`, { method: "PATCH", headers: { ...admin, "content-type": "application/json" }, body: JSON.stringify({ label: "Renommé" }) })).status, 200, "édition du libellé sans réécrire la config héritée");
    const viaKey = await (await fetch(`${s.base}/api/projects/${pid}`, { headers: { Authorization: `Bearer ${agent.key}` } })).json();
    const cfg = viaKey.indicators[0].config;
    assert.equal(cfg.password, "•••");
    assert.equal(cfg.nested, "•••", "clé hors schéma masquée en bloc");
    assert.equal(cfg.liste, "•••");
    assert.equal(cfg.url, "https://x.test", "source légitime intacte");
    assert.equal((await (await fetch(`${s.base}/api/projects/${pid}`, { headers: admin })).json()).indicators[0].config.password, "ADMIN-PW-1", "valeur toujours en base");
    const diag = await (await fetch(`${s.base}/api/diagnostic`, { headers: admin })).json();
    assert.ok(diag.events.some((e: any) => e.kind === "legacy_secret_config"), "événement de démarrage");
    assert.ok(diag.events.filter((e: any) => e.kind === "legacy_secret_config").every((e: any) => !String(e.detail).includes("ADMIN-PW-1")));
  } finally { s.stop(); t.done(); }
});
