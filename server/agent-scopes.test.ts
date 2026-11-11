// L1 : portée par projet, canAccess REST, migration des clés existantes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCOPES_MIGRATION } from "./agents.ts";
import { login, startServer, tempDb } from "./test-server.ts";

test("L1 : migration ancienne clé → tous projets avec drapeau", () => {
  const dir = mkdtempSync(join(tmpdir(), "st-scope-"));
  const db = new DatabaseSync(join(dir, "old.db"));
  try {
    db.exec("CREATE TABLE agent_keys (id TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, read_only INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, last_used INTEGER); CREATE TABLE projects (id TEXT PRIMARY KEY);");
    db.prepare("INSERT INTO agent_keys (id, name, hash, created_at) VALUES ('a','ancien','h',0)").run();
    db.exec(SCOPES_MIGRATION);
    const r = db.prepare("SELECT all_projects FROM agent_keys WHERE id='a'").get() as { all_projects: number };
    assert.equal(r.all_projects, 1, "clé existante : tous projets");
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("L1 : clé limitée = 200 sur son projet, 404 sur l'autre, agrégats et MCP filtrés par portée", async () => {
  const t = tempDb();
  const s = await startServer(t.path);
  try {
    const cookie = await login(s.base);
    const h = { Cookie: cookie, "content-type": "application/json" };
    const a = await (await fetch(`${s.base}/api/projects`, { method: "POST", headers: h, body: JSON.stringify({ name: "A" }) })).json();
    const b = await (await fetch(`${s.base}/api/projects`, { method: "POST", headers: h, body: JSON.stringify({ name: "B" }) })).json();
    assert.equal((await fetch(`${s.base}/api/agents`, { method: "POST", headers: h, body: JSON.stringify({ name: "Sans choix", read_only: false }) })).status, 400, "aucun projet sans choix explicite");
    const all = await (await fetch(`${s.base}/api/agents`, { method: "POST", headers: h, body: JSON.stringify({ name: "Tous", all_projects: true }) })).json();
    assert.equal(all.all_projects, true);
    assert.equal((await fetch(`${s.base}/api/projects`, { headers: { Authorization: `Bearer ${all.key}` } })).status, 200);
    const key = await (await fetch(`${s.base}/api/agents`, { method: "POST", headers: h, body: JSON.stringify({ name: "A seulement", read_only: false, projects: [a.id] }) })).json();
    const k = { Authorization: `Bearer ${key.key}`, "content-type": "application/json" };
    assert.equal((await fetch(`${s.base}/api/projects/${a.id}`, { headers: k })).status, 200);
    const bResponse = await fetch(`${s.base}/api/projects/${b.id}`, { headers: k });
    const unknown = await fetch(`${s.base}/api/projects/inconnu-xyz`, { headers: k });
    assert.equal(bResponse.status, 404); assert.equal(unknown.status, 404);
    assert.equal(await unknown.text(), await bResponse.text(), "même corps : aucune fuite d'existence");
    assert.equal((await fetch(`${s.base}/api/indicators/inconnu/collect`, { method: "POST", headers: k })).status, 404);
    assert.equal((await fetch(`${s.base}/api/sites/inconnu`, { headers: k })).status, 404);
    // L1 : les agrégats répondent mais ne contiennent que les projets de la portée.
    const list = await (await fetch(`${s.base}/api/projects`, { headers: k })).json() as any[];
    assert.equal(list.length, 1); assert.equal(list[0].id, a.id, "liste filtrée : seulement le projet autorisé");
    for (const path of ["/api/overview", "/api/today", "/api/portfolio", "/api/dashboards", "/api/sites"]) {
      assert.equal((await fetch(`${s.base}${path}`, { headers: k })).status, 200, path);
    }
    const pf = await (await fetch(`${s.base}/api/portfolio`, { headers: k })).json() as any;
    assert.equal(pf.projects.filter((r: any) => r.id === b.id).length, 0, "portefeuille : aucun projet hors portée");
    assert.equal(pf.projects.filter((r: any) => r.id === a.id).length, 1);
    const siteList = await (await fetch(`${s.base}/api/sites`, { headers: k })).json() as any[];
    assert.equal(siteList.length, 0, "aucun site hors portée");
    // MCP : outils filtrés par portée, cible hors portée refusée comme inexistante.
    const rpc = async (id: number, method: string, params?: unknown) => {
      const r = await fetch(`${s.base}/mcp`, { method: "POST", headers: { ...k, accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) });
      const text = await r.text();
      const body = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5).trim())).find((m) => m.id === id) ?? JSON.parse(text);
      return { status: r.status, body } as any;
    };
    const init = await rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-portee", version: "1" } });
    assert.equal(init.status, 200, JSON.stringify(init.body).slice(0, 200));
    const kpis = await rpc(2, "tools/call", { name: "projects_kpis", arguments: { days: 7 } });
    const rows = JSON.parse(kpis.body.result.content[0].text);
    assert.equal(rows.length, 1); assert.equal(rows[0].name, "A", "MCP : seulement le projet autorisé");
    const mcpPortfolio = JSON.parse((await rpc(3, "tools/call", { name: "portfolio_overview", arguments: { days: 7 } })).body.result.content[0].text);
    assert.deepEqual(mcpPortfolio.projects.map((p: any) => p.name), ["A"], "portefeuille MCP filtré");
    const other = await rpc(4, "tools/call", { name: "milestones_list", arguments: { project: b.id } });
    assert.ok(other.body.error || other.body.result?.isError, "cible hors portée refusée");
    // Portée maintenue après changement via l'administrateur.
    assert.equal((await fetch(`${s.base}/api/agents/${key.id}/scopes`, { method: "PUT", headers: k, body: JSON.stringify({ all_projects: true }) })).status, 403);
  } finally { s.stop(); t.done(); }
});
