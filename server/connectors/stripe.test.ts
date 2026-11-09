// Tests T11 (CA12) : connecteur Stripe avec clé restreinte. Fournisseur SIMULÉ (aucune requête vers Stripe).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { db } from "../db.ts";
import { markAdmin } from "../admin.ts";
import { connections } from "../connections.ts";
import { registerConnections, setConnectorContext } from "./api.ts";
import { setCollectContext, collectVia } from "./use.ts";
import { get, realCtx, runTest } from "./registry.ts";
import { checkContract } from "./contract.ts";
import { FIXTURES } from "./fixtures.ts";
import { saveIndicator, saveProject, collect, measure } from "../projects.ts";
import { VaultError, RECONNECT_MESSAGE } from "../vault.ts";
import "./index.ts";

process.env.SECRET = "t".repeat(40);
const stripe = get("stripe")!;
const KEY = "rk_" + "test_AbCdEfGhIjKlMnOpQrSt1234";
const sent: { url: string; headers: Record<string, string> }[] = [];
let forbid: string | null = null; let unauth = false;

const sim = realCtx({
  fetch: (async (u: any, i: RequestInit = {}) => {
    const url = String(u); sent.push({ url, headers: (i.headers ?? {}) as Record<string, string> });
    if (unauth) return new Response("{}", { status: 401 });
    if (forbid && url.includes(`/${forbid}`)) return new Response(JSON.stringify({ error: { message: "forbidden" } }), { status: 403 });
    return FIXTURES.stripe.respond!(url, i);
  }) as typeof fetch,
});
const admin = new Hono(); admin.use("*", (c, n) => { markAdmin(c); return n(); }); registerConnections(admin);
const post = (path: string, body: unknown) => admin.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
beforeEach(() => { sent.length = 0; forbid = null; unauth = false; process.env.SECRET = "t".repeat(40); db.exec("DELETE FROM connections"); setConnectorContext(sim); setCollectContext(sim); });

test("contrat commun : le connecteur Stripe est conforme", async () => {
  assert.deepEqual(await checkContract(stripe, FIXTURES.stripe), []);
});

test("CA12 : une clé sk_live_ (ou sk_org_) est refusée avec le message prévu, sans aucun appel réseau", async () => {
  for (const k of ["sk_" + "live_AbCdEfGhIjKlMnOpQrSt1234", "sk_" + "org_AbCdEfGhIjKlMnOpQrSt1234"]) {
    const r = await post("/api/connections", { kind: "stripe", values: { key: k } });
    assert.equal(r.status, 400); assert.equal((await r.json()).error, "Clé complète refusée : créez une clé limitée en lecture.");
  }
  const r = await post("/api/connections", { kind: "stripe", values: { key: "pas_une_cle_stripe" } });
  assert.equal((await r.json()).error, "Une clé limitée commence par rk_.");
  assert.equal(connections().length, 0); assert.equal(sent.length, 0);
});

test("CA12 : une clé rk_test_ est acceptée avec le badge test ; AUCUN en-tête Stripe-Account sur aucun appel", async () => {
  const r = await post("/api/connections", { kind: "stripe", values: { key: KEY } });
  assert.equal(r.status, 201);
  const j = await r.json();
  assert.equal(j.connection.test_mode, true); assert.equal(j.connection.label, "Boutique démo"); assert.equal(j.connection.hint, `rk_test_…${KEY.slice(-4)}`);
  assert.match(j.test.detail, /mode test/);
  assert.ok(sent.length >= 4, "balance, clients, abonnements, compte");
  for (const s of sent) { assert.equal(s.headers["Stripe-Account"], undefined); assert.equal(s.headers["Stripe-Context"], undefined); assert.equal(s.headers.Authorization, `Bearer ${KEY}`); }
  const live = await post("/api/connections", { kind: "stripe", values: { key: "rk_" + "live_AbCdEfGhIjKlMnOpQrSt9999" } });
  assert.equal((await live.json()).connection.test_mode, false);
});

test("permissions : 403 sur une ressource → « Permission manquante : … en lecture. » ; 401 → clé refusée ; rien d'enregistré", async () => {
  for (const [res, label] of [["balance_transactions", "Balance"], ["customers", "Customers"], ["subscriptions", "Subscriptions"]]) {
    forbid = res;
    const r = await post("/api/connections", { kind: "stripe", values: { key: KEY } });
    assert.equal(r.status, 400); assert.equal((await r.json()).error, `Permission manquante : ${label} en lecture.`);
  }
  forbid = null; unauth = true;
  const r = await post("/api/connections", { kind: "stripe", values: { key: KEY } });
  assert.equal((await r.json()).error, "Stripe refuse cette clé : vérifiez qu'elle est complète et active.");
  assert.equal(connections().length, 0);
});

test("relevés : CA net, nouveaux clients, abonnements actifs et MRR depuis une connexion, sans Stripe-Account", async () => {
  await post("/api/connections", { kind: "stripe", values: { key: KEY } });
  sent.length = 0;
  const p = saveProject(null, { name: "Projet Stripe" })!;
  const mk = (metric: string, mode: "daily" | "total") => saveIndicator(null, p.id, { label: metric, mode, source: "stripe", config: { metric } })!;
  assert.equal(await measure(mk("revenue", "daily"), "2026-11-09"), 10);      // charge 1250 + remboursement −250 = 1000 centimes ; stripe_fee n'est pas compté (déjà déduit du net de la vente)
  assert.equal(await measure(mk("new_customers", "daily"), "2026-11-09"), 2);
  assert.equal(await measure(mk("active_subscriptions", "total")), 1);
  assert.equal(await measure(mk("mrr", "total")), 29);
  assert.ok(sent.length >= 4);
  for (const s of sent) assert.equal(s.headers["Stripe-Account"], undefined);
  // un jour précis → bornes du jour civil dans la requête
  assert.ok(sent.some((s) => /created%5Bgte%5D=\d+/.test(s.url) && /created%5Blt%5D=\d+/.test(s.url)));
});

test("connection_id : l'indicateur utilise la connexion désignée ; connexion retirée → « Source retirée »", async () => {
  const a = await (await post("/api/connections", { kind: "stripe", label: "A", values: { key: KEY } })).json();
  const b = await (await post("/api/connections", { kind: "stripe", label: "B", values: { key: "rk_" + "test_Seconde0123456789abcdefg" } })).json();
  const p = saveProject(null, { name: "Deux comptes" })!;
  const ind = saveIndicator(null, p.id, { label: "MRR B", mode: "total", source: "stripe", config: { metric: "mrr", connection_id: b.connection.id } })!;
  sent.length = 0; await measure(ind);
  assert.equal(sent[0].headers.Authorization, "Bearer rk_" + "test_Seconde0123456789abcdefg");
  db.prepare("DELETE FROM connections WHERE id = ?").run(b.connection.id);
  await assert.rejects(measure(ind), /Source retirée/);
  assert.ok(a.connection.id);
});

test("clé refusée pendant un relevé → la connexion passe en « à reconnecter » et l'erreur est enregistrée", async () => {
  const c = await (await post("/api/connections", { kind: "stripe", values: { key: KEY } })).json();
  const p = saveProject(null, { name: "Révocation" })!;
  const ind = saveIndicator(null, p.id, { label: "MRR", mode: "total", source: "stripe", config: { metric: "mrr" } })!;
  unauth = true;
  await assert.rejects(collect(ind), /refuse cette clé/);
  assert.equal(connections().find((x) => x.id === c.connection.id)!.status, "reconnect");
  assert.match((db.prepare("SELECT last_error FROM indicators WHERE id = ?").get(ind.id) as any).last_error, /refuse cette clé/);
});

test("SECRET changé : le relevé échoue avec le message de rotation (VaultError), sans appel réseau", async () => {
  await post("/api/connections", { kind: "stripe", values: { key: KEY } });
  process.env.SECRET = "z".repeat(40); sent.length = 0;
  await assert.rejects(collectVia("stripe", undefined, "mrr", {}, undefined), (e: any) => e instanceof VaultError && e.message === RECONNECT_MESSAGE);
  assert.equal(sent.length, 0);
});

test("ancien mode : config.env garde la clé d'organisation et Stripe-Context (CA20, comportement conservé)", async () => {
  process.env.TEST_STRIPE_ORG = "sk_org_test";
  const p = saveProject(null, { name: "Env" })!;
  const ind = saveIndicator(null, p.id, { label: "Abos", mode: "total", source: "stripe", config: { env: "TEST_STRIPE_ORG", metric: "active_subscriptions", account: "acct_123" } })!;
  setCollectContext(undefined); // le chemin env utilise le réseau global, remplacé ici
  const real = globalThis.fetch; const seen: Record<string, string>[] = [];
  globalThis.fetch = (async (_u: string, init: RequestInit) => { seen.push(init.headers as Record<string, string>); return new Response(JSON.stringify({ data: [{ items: { data: [] } }], has_more: false })); }) as typeof fetch;
  try { assert.equal(await measure(ind), 1); assert.equal(seen[0]["Stripe-Context"], "acct_123"); } finally { globalThis.fetch = real; }
});

test("runTest : délai dépassé → message « Stripe ne répond pas »", async () => {
  const slow = realCtx({ timeoutMs: 40, fetch: (() => new Promise(() => {})) as typeof fetch });
  const r = await runTest(stripe, { config: {}, secrets: { key: KEY } }, slow);
  assert.equal(r.ok, false); assert.equal(r.error, "Stripe ne répond pas. Réessayez dans un instant.");
});
