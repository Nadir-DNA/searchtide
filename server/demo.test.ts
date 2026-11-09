// Mode démonstration : le serveur démarre (régression : une garde du module CRM faisait planter DEMO=1) et n'expose ni le CRM ni la prospection.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer, tempDb } from "./test-server.ts";

test("DEMO=1 : le serveur démarre, la lecture est ouverte, le CRM n'est pas exposé", async () => {
  const t = tempDb(); const s = await startServer(t.path, { DEMO: "1" });
  try {
    assert.equal((await fetch(`${s.base}/healthz`)).status, 200);
    assert.equal((await fetch(`${s.base}/api/me`)).status, 200);
    assert.equal((await (await fetch(`${s.base}/api/me`)).json()).demo, true);
    for (const path of ["/api/contacts", "/api/publications", "/api/business", "/api/outreach/templates"]) {
      const r = await fetch(`${s.base}${path}`);
      assert.doesNotMatch(r.headers.get("content-type") ?? "", /json/, `${path} ne doit pas répondre en JSON`);
    }
    const post = await fetch(`${s.base}/api/contacts`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(post.status, 401, "l'écriture reste protégée");
    assert.equal((await fetch(`${s.base}/inbound/lead`, { method: "POST" })).status === 401, false, "la route d'entrée des formulaires n'existe pas en démonstration");
  } finally { s.stop(); t.done(); }
});

test("T29 : la démonstration crée des données fictives une seule fois, sans aucune donnée réelle", async () => {
  const t = tempDb();
  let s = await startServer(t.path, { DEMO: "1" });
  try {
    const sites = await (await fetch(`${s.base}/api/sites`)).json();
    assert.deepEqual(sites.map((x: any) => x.domain).sort(), ["exemple-boutique.com", "exemple.com"]);
    const dash = await (await fetch(`${s.base}/api/overview?days=28`)).json();
    assert.ok(dash.daily.reduce((n: number, d: any) => n + d.visitors, 0) > 0, "des visites fictives existent");
    const projects = await (await fetch(`${s.base}/api/projects`)).json();
    assert.equal(projects.length, 2);
    s.stop(); await new Promise((r) => setTimeout(r, 300));
    s = await startServer(t.path, { DEMO: "1" });                       // redémarrage : aucune donnée dupliquée
    const again = await (await fetch(`${s.base}/api/sites`)).json();
    assert.equal(again.length, 2);
    const dash2 = await (await fetch(`${s.base}/api/overview?days=28`)).json();
    assert.ok(dash2.daily.reduce((n: number, d: any) => n + d.visitors, 0) > 0, "visites toujours là après redémarrage");
  } finally { s.stop(); t.done(); }
});
