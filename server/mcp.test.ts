// Accès MCP des agents : un client Streamable HTTP quelconque, avec sa propre clé, découvre les outils
// et lit projets, indicateurs, scores et portefeuille. Lecture seule par défaut ; aucune écriture via les outils de lecture.
// Vrai serveur, vraie base, vraies clés (jetables) ; aucun fournisseur joint.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer, login, seed, tempDb } from "./test-server.ts";
import { mcpAccess } from "./mcp.ts";
import { db } from "./db.ts";

const SEED = `import { saveProject, saveIndicator, record } from "@server/projects.ts";
import { createConnection } from "@server/connections.ts";
import { setEnabled } from "@server/modules/state.ts";
setEnabled("crm", true); setEnabled("publications", true);
const p = saveProject(null, { name: "Projet MCP", sites: [] });
const i = saveIndicator(null, p.id, { label: "Inscriptions", mode: "daily", source: "manual", config: {} });
record(i.id, new Date().toISOString().slice(0, 10), 42);
createConnection({ kind: "smtp", label: "Boîte privée", config: { hint: "moi@exemple.com · smtp.exemple.net", user: "moi@exemple.com", host: "smtp.exemple.net", port: 465 }, secrets: { pass: "PASSE-FACTICE-MCP" } });`;

type Json = any;

const headers = (key?: string) => ({
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  ...(key ? { authorization: `Bearer ${key}` } : {}),
});

/** Corps JSON ou SSE (`data: {...}`) selon le transport renvoyé par le serveur. */
function message(text: string, contentType: string, id: number): Json {
  if (contentType.includes("text/event-stream")) {
    const found = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5).trim())).find((m) => m.id === id);
    assert.ok(found, `réponse SSE sans id ${id} : ${text.slice(0, 200)}`);
    return found;
  }
  return JSON.parse(text);
}

async function rpc(base: string, key: string | undefined, id: number, method: string, params?: Json) {
  const r = await fetch(`${base}/mcp`, { method: "POST", headers: headers(key), body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) });
  const text = await r.text();
  return { status: r.status, contentType: r.headers.get("content-type") ?? "", body: r.status === 200 ? message(text, r.headers.get("content-type") ?? "", id) : null, text };
}

async function createKey(base: string, cookie: string, name: string, readOnly?: boolean) {
  const r = await fetch(`${base}/api/agents`, { method: "POST", headers: { Cookie: cookie, "content-type": "application/json" }, body: JSON.stringify(readOnly === undefined ? { name } : { name, read_only: readOnly }) });
  const text = await r.text();
  assert.equal(r.status, 201, text);
  return JSON.parse(text) as { id: string; name: string; read_only: boolean; key: string };
}

const toolNames = (body: Json): string[] => body.result.tools.map((t: Json) => t.name).sort();
const callText = (body: Json): Json => JSON.parse(body.result.content[0].text);

test("MCP lecture seule : initialize, tools/list et lecture des projets, indicateurs, scores et portefeuille", async () => {
  const t = tempDb(); seed(t.path, SEED);
  const s = await startServer(t.path);
  try {
    const cookie = await login(s.base);
    const agent = await createKey(s.base, cookie, "Client générique", true);
    const init = await rpc(s.base, agent.key, 1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "client-test", version: "1.0" } });
    assert.equal(init.status, 200, init.text.slice(0, 200));
    assert.equal(init.body.result.serverInfo.name, "searchtide");
    assert.ok(init.body.result.protocolVersion);

    const list = await rpc(s.base, agent.key, 2, "tools/list");
    assert.equal(list.status, 200);
    const names = toolNames(list.body);
    for (const n of ["list_sites", "projects_kpis", "portfolio_overview", "alerts", "connections_list", "dashboard_list"]) assert.ok(names.includes(n), `${n} manque`);
    for (const n of ["indicator_record", "sync_search_console", "crm_save_contact", "pubs_save", "dashboard_create", "widget_add"]) assert.ok(!names.includes(n), `${n} ne doit pas être exposé en lecture seule`);

    const projects = await rpc(s.base, agent.key, 3, "tools/call", { name: "projects_kpis", arguments: { days: 7 } });
    assert.equal(projects.status, 200);
    const projs = callText(projects.body);
    assert.equal(projs[0].name, "Projet MCP");
    assert.equal(projs[0].indicators[0].label, "Inscriptions");
    assert.equal(projs[0].indicators[0].value, 42, "l'indicateur est lisible");

    const portfolio = await rpc(s.base, agent.key, 4, "tools/call", { name: "portfolio_overview", arguments: { days: 7 } });
    const view = callText(portfolio.body);
    const row = view.projects.find((p: Json) => p.name === "Projet MCP");
    assert.ok(row, "le projet est dans le portefeuille");
    assert.ok(row.health && typeof row.health.coverage === "number", "le score de santé et sa couverture sont fournis");
    assert.ok("totals" in view && "alerts" in view);

    // Un outil d'écriture n'existe pas dans cette session : l'appel JSON-RPC échoue proprement, il n'écrit rien.
    const write = await rpc(s.base, agent.key, 5, "tools/call", { name: "indicator_record", arguments: { id: "x", value: 1 } });
    assert.ok(write.body.error || write.body.result?.isError, "outil d'écriture absent ou refusé");
  } finally { s.stop(); t.done(); }
});

test("MCP : clé absente ou inconnue refusée ; la démonstration anonyme n'a pas accès au MCP (E1)", async () => {
  const t = tempDb(); seed(t.path, SEED);
  const s = await startServer(t.path, { DEMO: "1" });
  try {
    const none = await rpc(s.base, undefined, 1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "anon", version: "1" } });
    assert.equal(none.status, 401);
    const wrong = await rpc(s.base, "ck_" + "inconnue_" + "0".repeat(24), 2, "tools/list");   // clé factice construite à l'exécution
    assert.equal(wrong.status, 401);
    // Même en DEMO, la lecture anonyme passe par l'API REST mais jamais par le MCP.
    assert.equal((await fetch(`${s.base}/api/sites`)).status, 200);
    const anonTool = await rpc(s.base, undefined, 3, "tools/call", { name: "projects_kpis", arguments: {} });
    assert.equal(anonTool.status, 401);
  } finally { s.stop(); t.done(); }
});

test("MCP : clé complète = outils d'écriture en plus ; sans read_only, la clé est en lecture seule (défaut)", async () => {
  const t = tempDb(); seed(t.path, SEED);
  const s = await startServer(t.path);
  try {
    const cookie = await login(s.base);
    const defaut = await createKey(s.base, cookie, "Sans option");                 // read_only omis
    assert.equal(defaut.read_only, true, "lecture seule par défaut");
    const complet = await createKey(s.base, cookie, "Complet", false);
    assert.equal(complet.read_only, false);
    const names = toolNames((await rpc(s.base, complet.key, 1, "tools/list")).body);
    for (const n of ["indicator_record", "dashboard_create", "widget_add", "crm_save_contact", "pubs_save"]) assert.ok(names.includes(n), `${n} attendu pour une clé complète`);
    const ro = toolNames((await rpc(s.base, defaut.key, 2, "tools/list")).body);
    assert.ok(!ro.includes("indicator_record"));
  } finally { s.stop(); t.done(); }
});

test("MCP (E1) : connections_list ne renvoie ni réglage ni secret, même en JSON-RPC", async () => {
  const t = tempDb(); seed(t.path, SEED);
  const s = await startServer(t.path);
  try {
    const cookie = await login(s.base);
    const agent = await createKey(s.base, cookie, "Lecteur", true);
    const r = await rpc(s.base, agent.key, 1, "tools/call", { name: "connections_list", arguments: {} });
    assert.equal(r.status, 200);
    const text = JSON.stringify(callText(r.body));
    assert.match(text, /Boîte privée/);
    // L'indice (« hint ») est prévu par R11 et peut citer l'adresse et l'hôte ; jamais les réglages ni le secret.
    for (const interdit of ["PASSE-FACTICE-MCP", "settings", "\"user\"", "\"port\"", "\"host\"", "\"pass\""]) assert.doesNotMatch(text, new RegExp(interdit), interdit);
  } finally { s.stop(); t.done(); }
});

test("MCP : la session administrateur (cookie) garde les écritures et n'est pas étiquetée démonstration", async () => {
  const t = tempDb(); seed(t.path, SEED);
  const s = await startServer(t.path);
  try {
    const cookie = await login(s.base);
    const list = await fetch(`${s.base}/mcp`, { method: "POST", headers: { ...headers(), Cookie: cookie }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    const text = await list.text();
    assert.equal(list.status, 200);
    const names = toolNames(message(text, list.headers.get("content-type") ?? "", 1));
    for (const n of ["indicator_record", "dashboard_create", "widget_add"]) assert.ok(names.includes(n), `${n} attendu pour l'administrateur`);
    // Le libellé journalisé ne doit pas faire passer un administrateur pour la démonstration.
    await fetch(`${s.base}/mcp`, { method: "POST", headers: { ...headers(), Cookie: cookie }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "projects_kpis", arguments: { days: 7 } } }) });
    const log = await (await fetch(`${s.base}/api/agents/log?limit=5`, { headers: { Cookie: cookie } })).json();
    assert.equal(log[0].agent, "Administrateur (session)");
    assert.notEqual(log[0].agent, "Démonstration (lecture seule)");
  } finally { s.stop(); t.done(); }
});

test("REST : une clé d'agent en lecture seule reçoit 403 sur une écriture, 200 en lecture", async () => {
  const t = tempDb(); seed(t.path, SEED);
  const s = await startServer(t.path);
  try {
    const cookie = await login(s.base);
    const agent = await createKey(s.base, cookie, "Lecteur REST", true);
    const auth = { Authorization: `Bearer ${agent.key}` };
    const write = await fetch(`${s.base}/api/projects`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ name: "Interdit" }) });
    const writeText = await write.text();
    assert.equal(write.status, 403, writeText);
    assert.match(writeText, /lecture seule/i);
    assert.equal((await fetch(`${s.base}/api/projects`, { headers: auth })).status, 200);
    assert.equal((await fetch(`${s.base}/api/agents`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ name: "Autre" }) })).status, 403);
  } finally { s.stop(); t.done(); }
});


test("MCP : les droits sont fermés par défaut — seul l'admin (cookie) et la clé principale écrivent", () => {
  const pc = { admin: false, apiKey: false, apiKeyRead: false };
  assert.deepEqual(mcpAccess("", { ...pc, admin: true }), { readOnly: false, agent: "Administrateur (session)" });
  assert.deepEqual(mcpAccess("", pc), { readOnly: true, agent: "Démonstration (lecture seule)" });
  assert.equal(mcpAccess("ck_inconnu", pc).readOnly, true, "jeton inconnu → lecture seule");
  assert.equal(mcpAccess("inconnu", pc).agent, "Lecture seule (jeton non reconnu)");
  assert.equal(mcpAccess("cle-principale", { ...pc, apiKey: true }).readOnly, false);
  assert.equal(mcpAccess("cle-lecture", { ...pc, apiKeyRead: true }).readOnly, true);
  // L'admin n'est reconnu que sans en-tête : un jeton inconnu accompagné d'un cookie admin reste en lecture seule.
  assert.equal(mcpAccess("inconnu", { ...pc, admin: true }).readOnly, true);
});

test("MCP (GET SSE) : un jeton inconnu en démonstration ne construit pas une session utilisable en POST", async () => {
  const t = tempDb(); seed(t.path, SEED);
  const s = await startServer(t.path, { DEMO: "1" });
  try {
    const unknown = "ck_" + "inconnu" + "0".repeat(20);
    const ac = new AbortController();
    const get = await fetch(`${s.base}/mcp`, { method: "GET", headers: { authorization: `Bearer ${unknown}`, accept: "text/event-stream" }, signal: ac.signal }).catch(() => null);
    ac.abort();                                   // le GET SSE ne sert qu'à ouvrir un flux : aucun outil appelé
    if (get) assert.ok(get.status !== 200 || (get.headers.get("content-type") ?? "").includes("text/event-stream"));
    // Le même jeton reste refusé en POST (401) : pas de session, donc pas d'outil d'écriture.
    assert.equal((await rpc(s.base, unknown, 1, "tools/call", { name: "indicator_record", arguments: { id: "x", value: 1 } })).status, 401);
  } finally { s.stop(); t.done(); }
});

test("B4/CA37 : sur une base neuve, read_only vaut 1 par défaut ; une clé explicite à 0 garde ses droits", () => {
  db.prepare("INSERT INTO agent_keys (id, name, hash, created_at) VALUES (?, ?, ?, ?)").run("b4-default", "Défaut", "hash-b4-1", Date.now());
  db.prepare("INSERT INTO agent_keys (id, name, hash, read_only, created_at) VALUES (?, ?, ?, ?, ?)").run("b4-explicit", "Explicite", "hash-b4-2", 0, Date.now());
  const def = db.prepare("SELECT read_only FROM agent_keys WHERE id = ?").get("b4-default") as { read_only: number };
  const exp = db.prepare("SELECT read_only FROM agent_keys WHERE id = ?").get("b4-explicit") as { read_only: number };
  assert.equal(def.read_only, 1);
  assert.equal(exp.read_only, 0, "les clés existantes ne sont pas migrées");
});
