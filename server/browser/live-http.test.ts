// B2 par HTTP : administrateur seul, ticket à usage unique, image SSE, relais d'entrée, fermeture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { login, startServer, tempDb } from "../test-server.ts";
import { startFixtures } from "./fixtures.ts";

const within = <T>(p: Promise<T>, ms: number): Promise<T> => Promise.race([
  p,
  new Promise<never>((_, reject) => setTimeout(() => reject(new Error("délai dépassé")), ms)),
]);

test("B2 HTTP : clé et anonyme refusés, ticket à usage unique, image reçue, fermeture", async () => {
  const t = tempDb();
  const s = await startServer(t.path, { BROWSER_SANDBOX: "0" });   // hôte de test : pages locales uniquement
  const f = await startFixtures();
  const admin = async () => ({ Cookie: await login(s.base), "content-type": "application/json" });
  try {
    const headers = await admin();
    const agent = await (await fetch(`${s.base}/api/agents`, { method: "POST", headers, body: JSON.stringify({ name: "vue-agent", all_projects: true }) })).json();
    const startBody = JSON.stringify({ url: `${f.url}/composer`, fixture_port: f.port });

    assert.equal((await fetch(`${s.base}/api/browser/live`, { method: "POST", headers: { Authorization: `Bearer ${agent.key}`, "content-type": "application/json" }, body: startBody })).status, 403, "clé d'agent refusée");
    assert.equal((await fetch(`${s.base}/api/browser/live`)).status, 401, "anonyme refusé");

    const start = await fetch(`${s.base}/api/browser/live`, { method: "POST", headers, body: startBody });
    assert.equal(start.status, 201, await start.clone().text());
    const { ticket } = await start.json();

    assert.equal((await fetch(`${s.base}/api/browser/live/input`, { method: "POST", headers, body: JSON.stringify({ ticket, event: { type: "text", text: "abc" } }) })).status, 200);
    assert.equal((await fetch(`${s.base}/api/browser/live/input`, { method: "POST", headers, body: JSON.stringify({ ticket, event: { type: "text", text: "x".repeat(2000) } }) })).status, 400, "entrée trop longue refusée");

    const stream = await within(fetch(`${s.base}/api/browser/live/stream?ticket=${encodeURIComponent(ticket)}`, { headers: { Cookie: headers.Cookie } }), 5_000);
    assert.equal(stream.status, 200);
    const reader = stream.body!.getReader();
    const first = await within(reader.read(), 20_000);   // attente de l'événement « image » ; les tests Chromium sont sérialisés (npm test)
    const text = new TextDecoder().decode(first.value);
    assert.match(text, /event: frame/, "une image JPEG arrive");

    const replay = await within(fetch(`${s.base}/api/browser/live/stream?ticket=${encodeURIComponent(ticket)}`, { headers: { Cookie: headers.Cookie } }), 5_000);
    assert.match(await within(replay.text(), 5_000), /déjà connectée/, "ticket à usage unique");
    // B2-D1 : coupure du flux par le client, puis reconnexion avec le même ticket = images reçues.
    await reader.cancel();
    let again = "";
    for (let i = 0; i < 20 && !/event: frame/.test(again); i++) {
      const re = await within(fetch(`${s.base}/api/browser/live/stream?ticket=${encodeURIComponent(ticket)}`, { headers: { Cookie: headers.Cookie } }), 5_000);
      const r2 = re.body!.getReader();
      again = new TextDecoder().decode((await within(r2.read(), 20_000)).value);
      await r2.cancel();
      if (!/event: frame/.test(again)) await new Promise((r) => setTimeout(r, 500));
    }
    assert.match(again, /event: frame/, "même ticket après coupure du flux");

    assert.equal((await fetch(`${s.base}/api/browser/live/close`, { method: "POST", headers, body: "{}" })).status, 200);
    const status = await (await fetch(`${s.base}/api/browser/status`, { headers })).json();
    assert.equal(status.open, false);
  } finally {
    await fetch(`${s.base}/api/browser/live/close`, { method: "POST", headers: await admin().catch(() => ({ "content-type": "application/json" })), body: "{}" }).catch(() => { /* rien à fermer */ });
    s.stop();
    t.done();
    await f.close();
  }
});
