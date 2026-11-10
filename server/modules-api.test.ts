// API des modules et outils MCP selon les modules actifs. Vrai serveur, vraie base ; aucun fournisseur joint.
import { test } from "node:test";
import assert from "node:assert/strict";
import { login, seed, startServer, tempDb } from "./test-server.ts";

const KEY = "cle-api-de-test-0001";
const SEED = `const { saveProject } = await import("@server/projects.ts"); saveProject(null, { name: "Alpha", sites: [] });`;
const mcpHeaders = (key: string) => ({ "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${key}` });

async function tools(base: string, key: string): Promise<string[]> {
  const r = await fetch(`${base}/mcp`, { method: "POST", headers: mcpHeaders(key), body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  const text = await r.text();
  const msg = text.includes("data:") ? JSON.parse(text.split("\n").find((l) => l.startsWith("data:"))!.slice(5)) : JSON.parse(text);
  return msg.result.tools.map((t: any) => t.name);
}
const projectId = async (base: string) => ((await (await fetch(`${base}/api/projects`, { headers: { authorization: `Bearer ${KEY}` } })).json()) as any[]).find((p) => p.name === "Alpha").id;

test("api modules : liste des modules avec leur état", async () => {
  const t = tempDb(); seed(t.path, SEED); const s = await startServer(t.path);
  try {
    const r = await fetch(`${s.base}/api/modules`, { headers: { authorization: `Bearer ${KEY}` } });
    const list = await r.json() as any[];
    assert.equal(list.length, 12);
    const crm = list.find((m) => m.id === "crm");
    assert.equal(crm.enabled, false); assert.equal(crm.status, "inactif");
    assert.equal(list.find((m) => m.id === "analytics").enabled, true);
  } finally { s.stop(); t.done(); }
});

test("api modules : une clé ne peut pas activer un module pour l'instance, la session le peut", async () => {
  const t = tempDb(); seed(t.path, SEED); const s = await startServer(t.path);
  try {
    const body = JSON.stringify({ enabled: true });
    assert.equal((await fetch(`${s.base}/api/modules/crm`, { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body })).status, 403);
    const cookie = await login(s.base);
    assert.equal((await fetch(`${s.base}/api/modules/crm`, { method: "POST", headers: { Cookie: cookie, "content-type": "application/json" }, body })).status, 200);
  } finally { s.stop(); t.done(); }
});

test("api modules : activer pour un projet sans connexion renvoie un message clair", async () => {
  const t = tempDb(); seed(t.path, SEED); const s = await startServer(t.path);
  try {
    const r = await fetch(`${s.base}/api/projects/${await projectId(s.base)}/modules/google`, { method: "PUT", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: JSON.stringify({ enabled: true }) });
    assert.equal(r.status, 400);
    assert.equal((await r.json() as any).error, "Connectez d'abord Google dans Modules.");
  } finally { s.stop(); t.done(); }
});

test("api modules : un module sans connecteur s'active pour un projet avec une clé en écriture", async () => {
  const t = tempDb(); seed(t.path, SEED + `const { setEnabled } = await import("@server/modules/state.ts"); setEnabled("crm", true);`); const s = await startServer(t.path);
  try {
    const pid = await projectId(s.base);
    const r = await fetch(`${s.base}/api/projects/${pid}/modules/crm`, { method: "PUT", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: JSON.stringify({ enabled: true }) });
    assert.equal(r.status, 200, await r.text());
    const list = await (await fetch(`${s.base}/api/modules`, { headers: { authorization: `Bearer ${KEY}` } })).json() as any[];
    assert.deepEqual(list.find((m) => m.id === "crm").projects, [pid]);
  } finally { s.stop(); t.done(); }
});

test("mcp : les outils CRM n'existent que si le module CRM est actif", async () => {
  const t = tempDb(); seed(t.path, SEED); let s = await startServer(t.path);
  try {
    let names = await tools(s.base, KEY);
    assert.ok(!names.some((n) => n.startsWith("crm_")), names.join(","));
    assert.ok(names.includes("modules_list") && names.includes("projects_kpis") && names.includes("jobs_status"));
    s.stop();
    seed(t.path, `const { setEnabled } = await import("@server/modules/state.ts"); setEnabled("crm", true);`);
    s = await startServer(t.path);
    names = await tools(s.base, KEY);
    assert.ok(names.includes("crm_list_contacts") && !names.includes("pubs_list"));
  } finally { s.stop(); t.done(); }
});

test("mcp : une clé en lecture seule n'a pas module_enable_for_project", async () => {
  const t = tempDb(); seed(t.path, SEED); const s = await startServer(t.path, { API_KEY_READ: "cle-lecture-de-test-01" });
  try {
    const ro = await tools(s.base, "cle-lecture-de-test-01");
    assert.ok(ro.includes("modules_list") && !ro.includes("module_enable_for_project"));
    assert.ok((await tools(s.base, KEY)).includes("module_enable_for_project"));
  } finally { s.stop(); t.done(); }
});

test("api : état des tâches de fond", async () => {
  const t = tempDb(); seed(t.path, SEED); const s = await startServer(t.path);
  try {
    const jobs = await (await fetch(`${s.base}/api/jobs`, { headers: { authorization: `Bearer ${KEY}` } })).json() as any[];
    assert.deepEqual(jobs.map((j) => j.id).sort(), ["alerts", "backup", "gsc-sync", "indicators", "offsite-backup", "sequences", "weekly-report"]);
  } finally { s.stop(); t.done(); }
});
