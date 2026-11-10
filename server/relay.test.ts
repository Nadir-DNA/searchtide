// v0.2.2 : relais côté instance (validation d'URL, PKCE, identifiant stable, lecture Stripe via relais, droits admin).
import { test } from "node:test";
process.env.SECRET ??= "t".repeat(40);
import assert from "node:assert/strict";
import { Hono } from "hono";
import { newPkce, instanceId, relayConfigured } from "./relay.ts";
import { stripe } from "./connectors/stripe.ts";
import { registerStripeOAuth } from "./stripe-oauth.ts";
import { createConnection, removeConnection } from "./connections.ts";
import { db } from "./db.ts";
import { saveIndicator, saveProject } from "./projects.ts";
import { registerConnections } from "./connectors/api.ts";
import { markAdmin } from "./admin.ts";
import type { Ctx } from "./connectors/types.ts";

test("RELAY_URL : https exigé, localhost toléré, vide = désactivé", () => {
  const prev = process.env.RELAY_URL;
  try {
    process.env.RELAY_URL = ""; assert.equal(relayConfigured(), false);
    process.env.RELAY_URL = "http://exemple.test"; assert.equal(relayConfigured(), false);
    process.env.RELAY_URL = "https://connect.exemple.test/"; assert.equal(relayConfigured(), true);
    process.env.RELAY_URL = "http://localhost:8787"; assert.equal(relayConfigured(), true);
  } finally { if (prev === undefined) delete process.env.RELAY_URL; else process.env.RELAY_URL = prev; }
});

test("PKCE S256 et identifiant d'instance stable", () => {
  const a = newPkce(), b = newPkce();
  assert.notEqual(a.verifier, b.verifier);
  assert.match(a.challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(instanceId(), instanceId());
  assert.match(instanceId(), /^inst_/);
});

test("Stripe via relais : test() et collect() passent uniquement par /v1/stripe/read", async () => {
  const calls: string[] = [];
  const ctx = { fetch: (async (u: any) => {
    const url = String(u); calls.push(url);
    if (url.endsWith("/v1/stripe/read")) return Response.json({ available: [{ amount: 1000, currency: "eur" }], pending: [] });
    return Response.json({});
  }) as typeof fetch } as Ctx;
  const cfg = { config: { relay: true, relay_url: "https://connect.test", account_name: "Boutique", livemode: false, hint: "relay_…abcd" }, secrets: { token: "relay_jeton" } };
  const r = await stripe.test!(cfg, ctx);
  assert.match(r.detail!, /via Searchtide Connect/);
  assert.equal(r.label, "Boutique");
  const value = await stripe.collect!(cfg, stripe.kpis!.find((k) => k.id === "revenue")!, {}, "2026-11-09", {
    ...ctx, fetch: (async () => Response.json({ data: [{ type: "charge", net: 900 }], has_more: false })) as typeof fetch,
  });
  assert.equal(value, 9);
  assert.ok(calls.every((u) => u === "https://connect.test/v1/stripe/read"));
});

test("CA33 : sans session administrateur, le démarrage OAuth est refusé", async () => {
  const app = new Hono(); registerStripeOAuth(app);
  const r = await app.request("/api/stripe-oauth/start", { method: "POST" });
  assert.equal(r.status, 403);
});

test("CA57 : retirer une connexion OAuth marque ses indicateurs « Source retirée »", async () => {
  db.exec("DELETE FROM indicators; DELETE FROM projects; DELETE FROM connections;");
  const c = createConnection({ kind: "stripe", label: "Relais", config: { relay: true, relay_url: "https://connect.test" }, secrets: { token: "relay_jeton" }, fingerprintOf: "relay:acct_1" });
  const p = saveProject(null, { name: "Projet relais" })!;
  const ind = saveIndicator(null, p.id, { label: "CA", mode: "total", source: "stripe", unit: "€", config: { metric: "revenue", connection_id: c.id } })!;
  const app = new Hono(); app.use("*", (ctx, next) => { markAdmin(ctx); return next(); }); registerConnections(app);
  const r = await app.request(`/api/connections/${c.id}`, { method: "DELETE" });
  assert.equal(r.status, 200);
  const row = db.prepare("SELECT last_error FROM indicators WHERE id = ?").get(ind.id) as any;
  assert.match(String(row.last_error), /Source retirée/);
  assert.equal(removeConnection(c.id), false, "déjà supprimée");
});
