// MCP-D1 : une clé limitée écrit seulement dans les projets en portée « write » ; liste blanche des outils.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { login, startServer, tempDb } from "./test-server.ts";

test("MCP-D1 : portée lecture = aucune écriture par le MCP, portée écriture = permise, outil non listé refusé", async () => {
  const t = tempDb();
  const s = await startServer(t.path);
  try {
    const h = { Cookie: await login(s.base), "content-type": "application/json" };
    const post = async (path: string, body: unknown) => (await fetch(`${s.base}${path}`, { method: "POST", headers: h, body: JSON.stringify(body) })).json() as Promise<any>;
    const a = await post("/api/projects", { name: "A" });
    const b = await post("/api/projects", { name: "B" });
    const ia = await post(`/api/projects/${a.id}/indicators`, { label: "Ventes A", mode: "daily", source: "manual" });
    const ib = await post(`/api/projects/${b.id}/indicators`, { label: "Ventes B", mode: "daily", source: "manual" });
    assert.ok(ia.id && ib.id, JSON.stringify([ia, ib]));
    const mk = async (scopes: { project_id: string; mode: "read" | "write" }[]) => (await post("/api/agents", { name: `k${scopes.map((x) => x.mode).join("")}${Math.random()}`, read_only: false, scopes })).key as string;
    const readKey = await mk([{ project_id: a.id, mode: "read" }]);
    const writeKey = await mk([{ project_id: a.id, mode: "write" }, { project_id: b.id, mode: "read" }]);
    let n = 0;
    const call = async (key: string, name: string, args: unknown) => {
      const rpc = async (method: string, params?: unknown) => {
        const r = await fetch(`${s.base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, ...(params ? { params } : {}) }) });
        const text = await r.text();
        return (text.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5).trim())).pop() ?? JSON.parse(text)) as any;
      };
      await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
      const r = await rpc("tools/call", { name, arguments: args });
      return { error: !!(r.error || r.result?.isError), text: JSON.stringify(r) };
    };
    const rows = () => { const d = new DatabaseSync(t.path); try { return { vals: (d.prepare("SELECT COUNT(*) c FROM metrics").get() as any).c, ms: (d.prepare("SELECT COUNT(*) c FROM annotations").get() as any).c }; } finally { d.close(); } };
    const before = rows();
    const writes: [string, unknown][] = [
      ["indicator_record", { id: ia.id, value: 123 }],
      ["milestone_save", { project: a.id, day: "2030-01-01", label: "x" }],
      ["module_disable_for_project", { project: a.id, module: "crm" }],
      ["kpi_add", { project: a.id, module: "analytics", kpi: "visitors" }],
    ];
    for (const [name, args] of writes) { const r = await call(readKey, name, args); assert.ok(r.error && /Introuvable/.test(r.text), `lecture : ${name} doit être refusé (${r.text.slice(0, 160)})`); }
    assert.deepEqual(rows(), before, "aucune ligne écrite par la clé en lecture");
    // Écriture : permise sur A, refusée sur B (portée lecture) et sur un indicateur de B.
    assert.equal((await call(writeKey, "indicator_record", { id: ia.id, value: 5 })).error, false);
    assert.equal((await call(writeKey, "milestone_save", { project: a.id, day: "2030-01-01", label: "ok" })).error, false);
    assert.ok((await call(writeKey, "indicator_record", { id: ib.id, value: 5 })).error, "B en lecture : refusé");
    assert.ok((await call(writeKey, "milestone_save", { project: b.id, day: "2030-01-01", label: "no" })).error);
    assert.equal(rows().vals, before.vals + 1); assert.equal(rows().ms, before.ms + 1);
    // Liste blanche : outils inter-projets refusés à toute clé limitée, même en écriture.
    for (const name of ["jobs_status", "agent_activity", "connections_list", "crm_summary"]) assert.ok((await call(writeKey, name, {})).error, name);
    assert.ok((await call(writeKey, "dashboard_create", { name: "x" })).error);
  } finally { s.stop(); t.done(); }
});
