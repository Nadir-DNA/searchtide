// A4 : les outils de mots-clés respectent la portée des clés d'agent (site hors portée = « Introuvable »).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { login, startServer, tempDb } from "./test-server.ts";

test("keyword_track : site du projet en écriture permis, site d'un projet en lecture refusé, REST idem", async () => {
  const t = tempDb();
  const s = await startServer(t.path);
  try {
    const h = { Cookie: await login(s.base), "content-type": "application/json" };
    const post = async (path: string, body: unknown, headers: Record<string, string> = h) => {
      const r = await fetch(`${s.base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => null) as any };
    };
    const sa = (await post("/api/sites", { domain: "a-mots.test" })).body, sb = (await post("/api/sites", { domain: "b-mots.test" })).body;
    const a = (await post("/api/projects", { name: "A", sites: ["a-mots.test"] })).body, b = (await post("/api/projects", { name: "B", sites: ["b-mots.test"] })).body;
    const en = await post("/api/modules/google", { enabled: true });
    assert.equal(en.status, 200);
    const key = (await post("/api/agents", { name: `mots${Math.random()}`, read_only: false, scopes: [{ project_id: a.id, mode: "write" }, { project_id: b.id, mode: "read" }] })).body.key as string;
    let n = 0;
    const rpc = async (method: string, params?: unknown) => {
      const r = await fetch(`${s.base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }) });
      const text = await r.text();
      return (text.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5).trim())).pop() ?? JSON.parse(text)) as any;
    };
    const call = async (name: string, args: unknown) => {
      await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
      const r = await rpc("tools/call", { name, arguments: args });
      return { error: !!(r.error || r.result?.isError), text: JSON.stringify(r) };
    };
    const ok = await call("keyword_track", { site: "a-mots.test", query: "devis" });
    assert.equal(ok.error, false, ok.text.slice(0, 300));
    const denied = await call("keyword_track", { site: "b-mots.test", query: "devis" });
    assert.ok(denied.error && /Introuvable/.test(denied.text), denied.text.slice(0, 200));
    assert.equal((await call("keywords_tracked", { site: "b-mots.test" })).error, false, "lecture permise sur B");
    // REST avec la même clé
    const bearer = { Authorization: `Bearer ${key}`, "content-type": "application/json" };
    assert.equal((await post(`/api/sites/${sa.id}/keywords`, { query: "prix" }, bearer)).status, 200);
    assert.equal((await post(`/api/sites/${sb.id}/keywords`, { query: "prix" }, bearer)).status, 404);
    const d = new DatabaseSync(t.path);
    try { assert.deepEqual((d.prepare("SELECT query FROM tracked_keywords WHERE site_id = ? ORDER BY query").all(sa.id) as any[]).map((x) => x.query), ["devis", "prix"]); }
    finally { d.close(); }
  } finally { s.stop(); t.done(); }
});
