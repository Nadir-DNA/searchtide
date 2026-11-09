// Tests T9 : API des connecteurs et des connexions, avec un connecteur fictif et un fournisseur SIMULÉ (aucun réseau).
// CA6 aucun secret dans les réponses · CA7 secret masqué dans erreurs et journaux · CA11 échec → aucune ligne · CA13 doublon · CA14 droits.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { db } from "../db.ts";
import { markAdmin, markClient } from "../admin.ts";
import { connections, getSecrets } from "../connections.ts";
import { SECRET_MESSAGE } from "../vault.ts";
import { registerConnections, listForClients, setConnectorContext } from "./api.ts";
import { register, realCtx, unregister } from "./registry.ts";
import type { Connector } from "./types.ts";

process.env.SECRET = "t".repeat(40);
const BODY = "Zq8LmN3vXw7YpR2sKd9HtBc4"; // partie aléatoire du faux secret
const KEY = `rk_test_${BODY}`;

type Reply = { status: number; body?: any; hang?: boolean };
let reply: Reply = { status: 200, body: { name: "Compte démo" } };
const seen: { url: string; auth: string | null }[] = [];

const fake: Connector = {
  id: "fakeprov", name: "Fournisseur démo", provider: "Démo", monogram: "FD", description: "Connecteur fictif de test", category: "revenus", minutes: 1,
  unlocks: ["Un chiffre"], fields: [
    { key: "key", label: "Clé", type: "text", secret: true, required: true },
    { key: "region", label: "Région", type: "select", options: [{ value: "eu", label: "Europe" }, { value: "us", label: "États-Unis" }] },
    { key: "creds", label: "Fichier", type: "json", secret: false },
  ], guide: [{ text: "Copiez la clé" }], hint: (c) => `${String(c.secrets.key).slice(0, 8)}…${String(c.secrets.key).slice(-4)}`,
  async test(c, ctx) {
    const r = await ctx.fetch("https://api.demo.test/account", { headers: { Authorization: `Bearer ${c.secrets.key}` } });
    if (r.status === 401) return { ok: false, error: "Démo refuse cette clé : vérifiez qu'elle est complète et active.", failure: "auth" };
    if (r.status === 403) return { ok: false, error: "Permission manquante : Balance en lecture.", failure: "permission" };
    if (!r.ok) return { ok: false, error: `Démo ${r.status} : ${await r.text()}`, failure: "other" };
    return { ok: true, label: (await r.json()).name, livemode: !String(c.secrets.key).includes("_test_") };
  },
};
const single: Connector = { ...fake, id: "soloprov", name: "Solo", singleton: true, fields: [{ key: "key", label: "Clé", type: "text", secret: true, required: true }] };

const sim = realCtx({
  timeoutMs: 80,
  fetch: (async (u: any, i: RequestInit = {}) => {
    seen.push({ url: String(u), auth: (i.headers as any)?.Authorization ?? null });
    if (reply.hang) return new Promise(() => {});
    return new Response(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body ?? {}), { status: reply.status });
  }) as typeof fetch,
});

const admin = new Hono(); admin.use("*", (c, n) => { markAdmin(c); return n(); }); registerConnections(admin);
// Clé d'API ou agent MCP : ils lisent la liste, ils n'écrivent pas
const anon = new Hono(); anon.use("*", (c, n) => { markClient(c); return n(); }); registerConnections(anon);
// Lecture ouverte de la démonstration : aucun identifiant
const open = new Hono(); registerConnections(open);
const post = (app: Hono, path: string, body: unknown, method = "POST") => app.request(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const count = () => (db.prepare("SELECT COUNT(*) AS n FROM connections").get() as any).n;

register(fake); register(single);
after(() => { unregister("fakeprov"); unregister("soloprov"); });
setConnectorContext(sim);
beforeEach(() => { reply = { status: 200, body: { name: "Compte démo" } }; seen.length = 0; process.env.SECRET = "t".repeat(40); db.exec("DELETE FROM connections"); });

/** CA6 : aucune sous-chaîne de 5 caractères ou plus de la partie aléatoire du secret. */
function assertNoSecret(text: string, body = BODY) {
  for (let i = 0; i + 5 <= body.length; i++) assert.ok(!text.includes(body.slice(i, i + 5)), `fragment « ${body.slice(i, i + 5)} » trouvé dans la réponse`);
}

test("catalogue : manifestes sans fonction ni secret, statut par connecteur", async () => {
  const r = await (await admin.request("/api/connectors")).json();
  const m = r.connectors.find((x: any) => x.id === "fakeprov");
  assert.equal(m.status, "none"); assert.equal(m.test, undefined); assert.equal(m.hint, undefined);
  assert.equal(r.vault.ok, true); assert.equal(r.admin, true); assert.ok(r.later.includes("Cloudflare"));
});

test("CA8 (HTTP) : SECRET absent ou dev-secret → 400 avec le message R2, rien d'écrit", async () => {
  for (const bad of [undefined, "dev-secret"]) {
    if (bad === undefined) delete process.env.SECRET; else process.env.SECRET = bad;
    const r = await post(admin, "/api/connections", { kind: "fakeprov", values: { key: KEY } });
    assert.equal(r.status, 400); assert.equal((await r.json()).error, SECRET_MESSAGE);
  }
  assert.equal(count(), 0); assert.equal(seen.length, 0, "le test n'est même pas lancé");
});

test("création : test avant enregistrement, secret chiffré, CA6 aucune fuite dans aucune réponse", async () => {
  const r = await post(admin, "/api/connections", { kind: "fakeprov", label: "", values: { key: KEY, region: "eu" } });
  assert.equal(r.status, 201);
  const text = await r.text(); assertNoSecret(text);
  const j = JSON.parse(text);
  assert.equal(j.connection.label, "Compte démo"); assert.equal(j.connection.status, "connected"); assert.equal(j.connection.hint, `rk_test_…${KEY.slice(-4)}`);
  assert.equal(j.connection.test_mode, true);
  assert.equal(seen.length, 1); assert.equal(seen[0].auth, `Bearer ${KEY}`);
  assert.equal(getSecrets(j.connection.id).key, KEY);
  for (const path of ["/api/connectors", "/api/connections"]) for (const app of [admin, anon]) assertNoSecret(await (await app.request(path)).text());
  assertNoSecret(JSON.stringify(listForClients()));
  assert.doesNotMatch(JSON.stringify(connections()), /secrets|fingerprint/);
});

test("CA11 : 401, 403 et délai dépassé → aucune ligne créée, messages de la table P4", async () => {
  reply = { status: 401 };
  let r = await post(admin, "/api/connections", { kind: "fakeprov", values: { key: KEY } });
  assert.equal(r.status, 400); assert.match((await r.json()).error, /refuse cette clé/);
  reply = { status: 403 };
  r = await post(admin, "/api/connections", { kind: "fakeprov", values: { key: KEY } });
  assert.equal(r.status, 400); assert.match((await r.json()).error, /Permission manquante : Balance en lecture/);
  reply = { status: 200, hang: true };
  const t0 = Date.now();
  r = await post(admin, "/api/connections", { kind: "fakeprov", values: { key: KEY } });
  const j = await r.json();
  assert.equal(r.status, 400); assert.equal(j.error, "Démo ne répond pas. Réessayez dans un instant."); assert.equal(j.failure, "timeout");
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(count(), 0);
});

test("CA7 : une erreur fournisseur qui renvoie la clé est nettoyée dans la réponse ET dans les journaux", async () => {
  reply = { status: 500, body: `Échec pour la clé ${KEY} (réessayez)` };
  const logs: string[] = []; const orig = console.error;
  console.error = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  let text: string;
  try { text = await (await post(admin, "/api/connections", { kind: "fakeprov", values: { key: KEY } })).text(); } finally { console.error = orig; }
  assert.match(text, /•••/); assert.doesNotMatch(text, new RegExp(BODY));
  assert.ok(logs.length >= 1); assert.ok(logs.every((l) => !l.includes(BODY)), logs.join("\n"));
  assert.equal(count(), 0);
});

test("CA13 : la même clé deux fois est refusée ; un connecteur unique ne se crée qu'une fois", async () => {
  assert.equal((await post(admin, "/api/connections", { kind: "fakeprov", label: "Premier", values: { key: KEY } })).status, 201);
  const r = await post(admin, "/api/connections", { kind: "fakeprov", values: { key: KEY } });
  assert.equal(r.status, 409); assert.equal((await r.json()).error, "Cette clé est déjà enregistrée sous « Premier ».");
  assert.equal((await post(admin, "/api/connections", { kind: "fakeprov", values: { key: KEY + "x" } })).status, 201, "une autre clé passe");
  assert.equal((await post(admin, "/api/connections", { kind: "soloprov", values: { key: "autre_cle_longue_0001" } })).status, 201);
  const s = await post(admin, "/api/connections", { kind: "soloprov", values: { key: "autre_cle_longue_0002" } });
  assert.equal(s.status, 409); assert.match((await s.json()).error, /déjà connecté/);
});

test("CA14 : sans session administrateur, POST/PATCH/DELETE/test → 403 ; GET renvoie la liste sans secret", async () => {
  await post(admin, "/api/connections", { kind: "fakeprov", values: { key: KEY } });
  const id = connections()[0].id;
  for (const [method, path, body] of [["POST", "/api/connections", { kind: "fakeprov", values: { key: KEY + "2" } }], ["PATCH", `/api/connections/${id}`, { label: "x" }], ["DELETE", `/api/connections/${id}`, {}], ["POST", `/api/connections/${id}/test`, {}]] as const) {
    const r = await anon.request(path, { method, headers: { "content-type": "application/json" }, body: method === "DELETE" ? undefined : JSON.stringify(body) });
    assert.equal(r.status, 403, `${method} ${path}`);
  }
  assert.equal(count(), 1); assert.equal(connections()[0].label, "Compte démo");
  const list = await (await anon.request("/api/connections")).text();
  assertNoSecret(list); assert.match(list, new RegExp(id));
});

test("validation : champ requis, JSON invalide, choix inconnu, connecteur inconnu", async () => {
  assert.match((await (await post(admin, "/api/connections", { kind: "fakeprov", values: {} })).json()).error, /Champ requis : Clé/);
  assert.match((await (await post(admin, "/api/connections", { kind: "fakeprov", values: { key: KEY, creds: "{pas json" } })).json()).error, /JSON valide/);
  assert.match((await (await post(admin, "/api/connections", { kind: "fakeprov", values: { key: KEY, region: "mars" } })).json()).error, /choix inconnu/);
  assert.equal((await post(admin, "/api/connections", { kind: "inexistant", values: {} })).status, 400);
  assert.equal(count(), 0);
});

test("remplacer la clé : même id, ancien secret gardé si le test échoue, libellé modifiable sans retest", async () => {
  const created = await (await post(admin, "/api/connections", { kind: "fakeprov", label: "Mon compte", values: { key: KEY } })).json();
  const id = created.connection.id;
  const KEY2 = "rk_" + "test_Nouvelle0123456789abcdef";
  reply = { status: 401 };
  assert.equal((await post(admin, `/api/connections/${id}`, { values: { key: KEY2 } }, "PATCH")).status, 400);
  assert.equal(getSecrets(id).key, KEY, "la clé actuelle n'est pas remplacée si le test échoue");
  reply = { status: 200, body: { name: "Autre nom" } };
  const r = await post(admin, `/api/connections/${id}`, { values: { key: KEY2 } }, "PATCH");
  assert.equal(r.status, 200); assertNoSecret(await r.text(), "Nouvelle0123456789abcdef");
  assert.equal(getSecrets(id).key, KEY2); assert.equal(connections().length, 1); assert.equal(connections()[0].id, id);
  const calls = seen.length;
  const rn = await post(admin, `/api/connections/${id}`, { label: "Renommée" }, "PATCH");
  assert.equal((await rn.json()).connection.label, "Renommée"); assert.equal(seen.length, calls, "renommer ne relance pas de test");
  assert.equal(getSecrets(id).key, KEY2);
  // champ secret laissé vide = on garde la clé
  const keep = await post(admin, `/api/connections/${id}`, { values: { key: "", region: "us" } }, "PATCH");
  assert.equal(keep.status, 200); assert.equal(getSecrets(id).key, KEY2); assert.equal(connections()[0].config.region, "us");
});

test("/test : met à jour le statut (connecté, à reconnecter sur 401) sans rien modifier d'autre", async () => {
  const { connection } = await (await post(admin, "/api/connections", { kind: "fakeprov", values: { key: KEY } })).json();
  reply = { status: 401 };
  let j = await (await post(admin, `/api/connections/${connection.id}/test`, {})).json();
  assert.equal(j.ok, false); assert.equal(j.status, "reconnect");
  assert.equal(connections()[0].status, "reconnect"); assert.match(connections()[0].status_detail, /refuse cette clé/);
  reply = { status: 200, body: { name: "Compte démo" } };
  j = await (await post(admin, `/api/connections/${connection.id}/test`, {})).json();
  assert.equal(j.status, "connected"); assert.equal(connections()[0].status, "connected"); assert.equal(connections()[0].status_detail, null);
  assert.equal(getSecrets(connection.id).key, KEY);
});

test("DELETE (administrateur) supprime la ligne et ses secrets", async () => {
  const { connection } = await (await post(admin, "/api/connections", { kind: "fakeprov", values: { key: KEY } })).json();
  assert.equal((await admin.request(`/api/connections/${connection.id}`, { method: "DELETE" })).status, 200);
  assert.equal(count(), 0);
  assert.equal((await admin.request(`/api/connections/${connection.id}`, { method: "DELETE" })).status, 404);
});

test("mode DEMO : l'écriture est désactivée", async () => {
  process.env.DEMO = "1";
  try { const r = await post(admin, "/api/connections", { kind: "fakeprov", values: { key: KEY } }); assert.equal(r.status, 403); assert.match((await r.json()).error, /démonstration/); }
  finally { delete process.env.DEMO; }
});

// ───────── E1 : réglages réservés à l'administrateur (R11) ─────────
test("E1 : l'administrateur voit indice, réglages non secrets et détail du statut ; une clé d'API ou un agent ne voient que id, type, libellé, indice, statut", async () => {
  const created = await (await post(admin, "/api/connections", { kind: "fakeprov", label: "Mon compte", values: { key: KEY, region: "eu" } })).json();
  assert.deepEqual(created.connection.settings, { region: "eu" });
  db.prepare("UPDATE connections SET status = 'error', status_detail = 'Démo : délai dépassé' WHERE id = ?").run(created.connection.id);
  for (const path of ["/api/connections", "/api/connectors"]) {
    const a = await (await admin.request(path)).json();
    const ac = (path === "/api/connections" ? a.list : a.connectors.find((x: any) => x.id === "fakeprov").connections)[0];
    assert.deepEqual(ac.settings, { region: "eu" }, `${path} (admin)`); assert.equal(ac.status_detail, "Démo : délai dépassé"); assert.ok(ac.hint);
    const k = await (await anon.request(path)).json();
    const kc = (path === "/api/connections" ? k.list : k.connectors.find((x: any) => x.id === "fakeprov").connections)[0];
    assert.equal(kc.settings, undefined, `${path} (clé d'API) ne renvoie aucun réglage`); assert.equal(kc.status_detail, null, "ni détail du statut");
    assert.deepEqual(Object.keys(kc).sort(), ["created_at", "hint", "id", "kind", "label", "livemode", "status", "status_detail", "test_mode", "tested_at"]);
    assert.equal(kc.hint, ac.hint); assert.equal(kc.label, "Mon compte");
  }
  const mcp = listForClients();
  assert.equal((mcp[0] as any).settings, undefined); assert.equal(mcp[0].status_detail, null); assert.ok(mcp[0].hint);
  assert.doesNotMatch(JSON.stringify(mcp), /"region"|délai dépassé/);
});

test("E1 : lecture ouverte de la démonstration (aucun identifiant) → ni indice, ni réglage, ni connexion", async () => {
  await post(admin, "/api/connections", { kind: "fakeprov", label: "Compte privé", values: { key: KEY, region: "eu" } });
  process.env.DEMO = "1";
  try {
    const list = await (await open.request("/api/connections")).json();
    assert.deepEqual(list.list, []);
    const cat = await (await open.request("/api/connectors")).json();
    const m = cat.connectors.find((x: any) => x.id === "fakeprov");
    assert.deepEqual(m.connections, []); assert.equal(m.status, "none"); assert.equal(cat.admin, false);
    const text = JSON.stringify(cat) + JSON.stringify(list);
    assert.doesNotMatch(text, /Compte privé|"hint":"rk_|"settings"|"region":"eu"/);
  } finally { delete process.env.DEMO; }
});
