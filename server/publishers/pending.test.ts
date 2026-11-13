// Publication en deux temps (Instagram simulé) : file → « en traitement » → relecture → publié ; lien public signé du média.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
process.env.DATABASE_PATH ??= ":memory:";
process.env.SECRET = "p".repeat(40);
process.env.PUBLIC_URL = "https://instance.test";
const { Hono } = await import("hono");
const { db } = await import("../db.ts");
const { savePublication } = await import("../business.ts");
const { createConnection } = await import("../connections.ts");
const { createConnectedAccount, getPublication, queuePublication, runPendingChecks, attemptsOf } = await import("./queue.ts");
const { registerMedia, signedMediaUrl } = await import("./media.ts");

const TODAY = new Date().toISOString().slice(0, 10);
const real = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = real; });

function setup() {
  const project = `q-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare("INSERT OR IGNORE INTO projects (id, name, crm_key, created_at) VALUES (?, ?, ?, 0)").run(`id-${project}`, project, project);
  const conn = createConnection({ kind: "instagram", label: "@nadir", account: "IG1", secrets: { access_token: "PT", expires_at: null }, fingerprintOf: `instagram:${project}` });
  const account = createConnectedAccount({ project, network: "instagram", label: "@nadir", connection_id: conn.id });
  const pub = savePublication(null, { day: TODAY, title: "Post", project, network: "instagram", status: "scheduled" }) as Record<string, any>;
  const file = join(mkdtempSync(join(tmpdir(), "st-media-")), "img");
  writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  db.prepare("INSERT INTO pub_media (id, publication_id, name, mime, size, path, created_at) VALUES (?, ?, 'img', 'image/jpeg', 4, ?, ?)").run(`m-${project}`, pub.id, file, Date.now());
  return { account, pub, mediaId: `m-${project}` };
}

test("deux temps : en traitement, une seule ligne d'historique, puis publié à la relecture", async () => {
  const { account, pub, mediaId } = setup();
  let status = "IN_PROGRESS", sentUrl = "";
  globalThis.fetch = (async (u: any, i: any = {}) => {
    const url = String(u);
    if (url.endsWith("/IG1/media")) { sentUrl = (i.body as URLSearchParams).get("image_url") ?? ""; return new Response(JSON.stringify({ id: "C1" })); }
    if (url.includes("/C1?")) return new Response(JSON.stringify({ status_code: status }));
    if (url.endsWith("/media_publish")) return new Response(JSON.stringify({ id: "MED" }));
    if (url.includes("/MED?")) return new Response(JSON.stringify({ permalink: "https://www.instagram.com/p/x/" }));
    throw new Error(`inattendu ${url}`);
  }) as typeof fetch;
  const p = await queuePublication(pub.id, { now: true, account_id: account.id, text: "Légende" });
  assert.equal(p?.state, "processing");
  assert.ok(sentUrl.startsWith(`https://instance.test/m/${mediaId}/`), "Instagram reçoit le lien signé de l'instance");

  // Pendant le traitement, le lien signé sert le fichier ; une signature fausse ne sert rien.
  const app = new Hono(); registerMedia(app);
  const path = new URL(sentUrl).pathname;
  assert.equal((await app.request(path)).status, 200);
  assert.equal((await app.request(path.replace(/[^/]+$/, "x".repeat(32)))).status, 404);

  await runPendingChecks();
  assert.equal(getPublication(pub.id)?.state, "processing");
  status = "FINISHED";
  await runPendingChecks();
  const done = getPublication(pub.id)!;
  assert.equal(done.state, "published");
  assert.equal(done.evidence_url, "https://www.instagram.com/p/x/");
  assert.equal((attemptsOf(pub.id) as any[]).filter((a) => a.state === "processing").length, 1);
  // Publiée : le lien public ne sert plus le média.
  assert.equal((await app.request(path)).status, 404);
});

test("deux temps : traitement de plus de 2 h → à vérifier, sans nouvel appel au réseau", async () => {
  const { account, pub } = setup();
  globalThis.fetch = (async (u: any) => String(u).endsWith("/IG1/media") ? new Response(JSON.stringify({ id: "C2" })) : new Response(JSON.stringify({ status_code: "IN_PROGRESS" }))) as typeof fetch;
  await queuePublication(pub.id, { now: true, account_id: account.id, text: "x" });
  let calls = 0; globalThis.fetch = (async () => { calls++; return new Response("{}"); }) as typeof fetch;
  await runPendingChecks(Date.now() + 3 * 3600_000);
  assert.equal(getPublication(pub.id)?.state, "to_verify");
  assert.equal(calls, 0);
});

test("Instagram réel sans PUBLIC_URL en https : refusé avant la file", async () => {
  const { account, pub } = setup();
  process.env.PUBLIC_URL = "http://localhost:3000";
  try { await assert.rejects(queuePublication(pub.id, { now: true, account_id: account.id, text: "x" }), /PUBLIC_URL en https/); }
  finally { process.env.PUBLIC_URL = "https://instance.test"; }
  assert.match(signedMediaUrl("abc"), /^https:\/\/instance\.test\/m\/abc\/\d+\/[\w-]{32}$/);
});
