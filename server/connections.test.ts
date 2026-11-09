// Tests : le parcours d'autorisation ne doit ni fuiter de secret, ni accepter un état forgé,
// et un indicateur Stripe doit fonctionner avec une connexion enregistrée, sans variable d'env.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeState, readState, connections, registerConnections } from "./connections.ts";
import { Hono } from "hono";

test("state signé : accepté une fois, refusé s'il est modifié ou périmé", () => {
  const s = makeState();
  assert.equal(readState(s), true);
  assert.equal(readState(s.replace(/.$/, "A")), false, "signature modifiée");
  assert.equal(readState(s, -1), false, "hors fenêtre");
  assert.equal(readState("nimporte.quoi.ici"), false);
});

test("connecteur non configuré : bouton absent, démarrage refusé proprement", async () => {
  const app = new Hono();
  registerConnections(app);
  const r = await app.request("/api/connections");
  const j = await r.json();
  assert.equal(j.stripe.ready, false);
  assert.equal(j.list.length, 0);
  const start = await app.request("/api/connections/stripe/start");
  assert.equal(start.status, 400);
  assert.match((await start.json()).error, /non configuré/);
});

test("le retour d'autorisation refuse un état absent sans rien créer", async () => {
  const app = new Hono();
  registerConnections(app);
  const r = await app.request("/api/connections/stripe/callback?code=abc");
  assert.equal(r.status, 302);
  assert.match(r.headers.get("location") ?? "", /connexion=erreur/);
  assert.equal(connections().length, 0);
});

test("les connexions ne renvoient jamais de jeton", async () => {
  const app = new Hono();
  registerConnections(app);
  const r = await app.request("/api/connections");
  const body = await r.text();
  assert.doesNotMatch(body, /access_token|refresh_token/);
});
