// L1-D1 : un bloc de page qui désigne un domaine, projet ou indicateur hors portée n'est servi ni en REST ni en MCP.
import { test } from "node:test";
import assert from "node:assert/strict";
import { login, startServer, tempDb } from "./test-server.ts";

test("L1-D1 : blocs à options site/project/indicator hors portée filtrés (REST et MCP), blocs de la portée conservés", async () => {
  const t = tempDb();
  const s = await startServer(t.path);
  try {
    const h = { Cookie: await login(s.base), "content-type": "application/json" };
    const post = async (path: string, body: unknown) => (await fetch(`${s.base}${path}`, { method: "POST", headers: h, body: JSON.stringify(body) })).json() as Promise<any>;
    const a = await post("/api/projects", { name: "A", sites: ["a-franky.test"] });
    const b = await post("/api/projects", { name: "B", sites: ["b-franky.test"] });
    const ib = await post(`/api/projects/${b.id}/indicators`, { label: "Ventes B", mode: "daily", source: "manual" });
    const page = await post("/api/dashboards", { name: "Mixte", widgets: [
      { type: "note", options: { text: "ok-portée", site: "a-franky.test" } },
      { type: "note", options: { text: "fuite-site", site: "b-franky.test" } },
      { type: "note", options: { text: "fuite-indicateur", indicator: ib.id } },
      { type: "note", options: { text: "fuite-projet", project: b.id } },
      { type: "note", options: { text: "libre mentionnant b-franky.test dans une phrase" } },
    ] });
    assert.ok(page.id, JSON.stringify(page));
    const key = await post("/api/agents", { name: "A seul", read_only: true, projects: [a.id] });
    const texts = (ws: any[]) => ws.map((w) => w.options.text).sort();
    const expected = ["libre mentionnant b-franky.test dans une phrase", "ok-portée"];
    const rest = await (await fetch(`${s.base}/api/dashboards`, { headers: { Authorization: `Bearer ${key.key}` } })).json() as any;
    assert.deepEqual(texts(rest.dashboards.find((d: any) => d.id === page.id).widgets), expected);
    const rpc = async (method: string, id: number, params?: unknown) => {
      const r = await fetch(`${s.base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${key.key}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) });
      const text = await r.text();
      return (text.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5).trim())).pop() ?? JSON.parse(text)) as any;
    };
    await rpc("initialize", 1, { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    const list = JSON.parse((await rpc("tools/call", 2, { name: "dashboard_list", arguments: {} })).result.content[0].text) as any[];
    assert.deepEqual(texts(list.find((d) => d.id === page.id).widgets), expected);
    const one = JSON.parse((await rpc("tools/call", 3, { name: "dashboard_get", arguments: { page: page.id } })).result.content[0].text);
    assert.deepEqual(texts(one.widgets), expected);
  } finally { s.stop(); t.done(); }
});
