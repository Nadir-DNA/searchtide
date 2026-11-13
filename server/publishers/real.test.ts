// Publication réelle : jeton du coffre, renouvellement, expiration, idempotence — LinkedIn simulé, aucun appel réel.
import { test } from "node:test";
import assert from "node:assert/strict";
process.env.SECRET = "r".repeat(40);
process.env.LINKEDIN_CLIENT_ID = "cid"; process.env.LINKEDIN_CLIENT_SECRET = "csec";
const { db } = await import("../db.ts");
const { savePublication } = await import("../business.ts");
const { createConnection, getSecrets, getConnection } = await import("../connections.ts");
const { createConnectedAccount, getPublication, queuePublication, retryPublication } = await import("./queue.ts");

const TODAY = new Date().toISOString().slice(0, 10);
const real = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = real; });

function setup(secrets: Record<string, unknown>) {
  const project = `r-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare("INSERT OR IGNORE INTO projects (id, name, crm_key, created_at) VALUES (?, ?, ?, 0)").run(`id-${project}`, project, project);
  const conn = createConnection({ kind: "linkedin", label: "Nadir", account: "abc", secrets, fingerprintOf: `linkedin:${project}` });
  const account = createConnectedAccount({ project, network: "linkedin", label: "Nadir", connection_id: conn.id });
  const pub = savePublication(null, { day: TODAY, title: "Post", project, network: "linkedin", status: "scheduled" }) as Record<string, any>;
  return { project, conn, account, pub };
}
const future = () => Date.now() + 3600_000;

test("réel : jeton valide du coffre → publié avec l'adresse LinkedIn, jeton envoyé en Bearer", async () => {
  const { account, pub } = setup({ access_token: "TOK", refresh_token: null, expires_at: future() });
  let auth = "";
  globalThis.fetch = (async (_u: any, i: any) => { auth = i.headers.Authorization; return new Response("", { status: 201, headers: { "x-restli-id": "urn:li:share:9" } }); }) as typeof fetch;
  const done = await queuePublication(pub.id, { now: true, account_id: account.id, text: "Bonjour" });
  assert.equal(done?.state, "published");
  assert.match(String(done?.evidence_url), /^https:\/\/www\.linkedin\.com\/feed\/update\//);
  assert.equal(auth, "Bearer TOK");
});

test("réel : jeton expiré sans renouvellement → compte à reconnecter, rien n'est envoyé", async () => {
  const { account, conn, pub } = setup({ access_token: "OLD", refresh_token: null, expires_at: Date.now() - 1000 });
  let called = false; globalThis.fetch = (async () => { called = true; return new Response(""); }) as typeof fetch;
  const done = await queuePublication(pub.id, { now: true, account_id: account.id, text: "Bonjour" });
  assert.equal(done?.state, "needs_action");
  assert.equal(called, false);
  assert.equal(getConnection(conn.id)?.status, "reconnect");
  assert.equal((db.prepare("SELECT status FROM pub_accounts WHERE id = ?").get(account.id) as any).status, "expired");
});

test("réel : jeton proche de l'échéance renouvelé et réécrit dans le coffre", async () => {
  const { account, conn, pub } = setup({ access_token: "OLD", refresh_token: "REF", expires_at: Date.now() + 60_000 });
  const urls: string[] = [];
  globalThis.fetch = (async (u: any) => {
    urls.push(String(u));
    if (String(u).includes("accessToken")) return new Response(JSON.stringify({ access_token: "NEW", refresh_token: "REF2", expires_in: 3600 }), { status: 200 });
    if (String(u).includes("userinfo")) return new Response(JSON.stringify({ sub: "abc", name: "Nadir" }), { status: 200 });
    return new Response("", { status: 201, headers: { "x-restli-id": "urn:li:share:1" } });
  }) as typeof fetch;
  const done = await queuePublication(pub.id, { now: true, account_id: account.id, text: "Bonjour" });
  assert.equal(done?.state, "published");
  assert.equal(getSecrets(conn.id).access_token, "NEW");
  assert.equal(getSecrets(conn.id).refresh_token, "REF2");
});

test("réel : refus 422 = échec relançable ; 503 = à vérifier, jamais rejoué à l'aveugle", async () => {
  const { account, pub } = setup({ access_token: "T", refresh_token: null, expires_at: future() });
  globalThis.fetch = (async () => new Response("doublon", { status: 422 })) as typeof fetch;
  assert.equal((await queuePublication(pub.id, { now: true, account_id: account.id, text: "A" }))?.state, "failed");
  let n = 0;
  globalThis.fetch = (async () => { n++; return new Response("", { status: 503 }); }) as typeof fetch;
  assert.equal((await retryPublication(pub.id))?.state, "to_verify");
  assert.equal(n, 1);
  assert.equal(getPublication(pub.id)?.state, "to_verify");
});

test("réel : texte plafonné à 3000 caractères", async () => {
  const { account, pub } = setup({ access_token: "T", expires_at: future() });
  await assert.rejects(queuePublication(pub.id, { now: true, account_id: account.id, text: "a".repeat(3001) }), /Texte trop long pour linkedin : 3001 \/ 3000/);
});
