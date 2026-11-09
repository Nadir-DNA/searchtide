// Tests T8 (CA15) : registre, exécution protégée, contrat commun. Le vérificateur est lui-même testé sur des connecteurs fautifs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { all, get, publicManifest, register, runCollect, runTest, unregister } from "./registry.ts";
import { checkContract, type Fixture } from "./contract.ts";
import { ConnectorError, type Cfg, type Connector, type Ctx } from "./types.ts";
import { FIXTURES } from "./fixtures.ts";

const KEY = "tok_SECRET_1234567890";
const cfg: Cfg = { config: { host: "api.exemple.test" }, secrets: { key: KEY } };

const good: Connector = {
  id: "demo", name: "Démo", provider: "Démo", monogram: "DE", description: "Connecteur de démonstration", category: "seo", minutes: 1,
  unlocks: ["Une valeur"], fields: [{ key: "key", label: "Clé", type: "text", secret: true, required: true }], guide: [{ text: "Copiez la clé" }],
  readPosts: ["POST https://api.exemple.test/token"],
  kpis: [{ id: "v", label: "Valeur", mode: "total" }],
  hint: (c) => `…${String(c.secrets.key).slice(-4)}`,
  async test(c, ctx) { const r = await ctx.fetch(`https://${c.config.host}/whoami`, { headers: { Authorization: `Bearer ${c.secrets.key}` } }); return r.ok ? { ok: true, label: "Compte démo" } : { ok: false, error: "refusé", failure: "auth" }; },
  async collect(c, _k, _p, _d, ctx) { await ctx.fetch("https://api.exemple.test/token", { method: "POST" }); return Number((await (await ctx.fetch("https://api.exemple.test/v")).json()).v); },
};
const fx: Fixture = { cfg, respond: (u) => new Response(JSON.stringify(u.endsWith("/v") ? { v: 7 } : {})) };

test("registre : enregistrement, doublon refusé, manifeste public sans fonctions ni secrets", () => {
  register(good);
  assert.equal(get("demo"), good);
  assert.throws(() => register(good), /déjà enregistré/);
  assert.throws(() => register({ ...good, id: "Mauvais Id" }), /invalide/);
  const pub = publicManifest(good) as any;
  assert.equal(pub.test, undefined); assert.equal(pub.collect, undefined); assert.equal(pub.hint, undefined); assert.equal(pub.readPosts, undefined);
  assert.equal(pub.hasKpis, true);
  unregister("demo");
  assert.equal(all().some((c) => c.id === "demo"), false);
});

test("contrat : un connecteur conforme passe", async () => {
  assert.deepEqual(await checkContract(good, fx), []);
});

test("contrat : une requête POST non déclarée est détectée", async () => {
  const bad: Connector = { ...good, readPosts: [], async test(c, ctx) { await ctx.fetch("https://api.exemple.test/ecrire", { method: "POST" }); return { ok: true }; } };
  const v = await checkContract(bad, fx);
  assert.ok(v.some((m) => /POST non déclarée/.test(m)), v.join(" | "));
});

test("contrat : secret journalisé, hint qui contient le secret, e-mail non déclaré", async () => {
  const bad: Connector = { ...good, hint: (c) => `clé ${c.secrets.key}`,
    async test(c, ctx) { console.log("clé", c.secrets.key); ctx.smtp({ host: "h", port: 1, secure: false }).sendMail({}); return { ok: true }; } };
  const v = (await checkContract(bad, fx)).join(" | ");
  assert.match(v, /hint contient un secret/); assert.match(v, /journaux/); assert.match(v, /e-mail non déclaré/);
});

test("contrat : manifeste invalide (monogramme, preset inconnu, KPI sans collect)", async () => {
  const bad: Connector = { ...good, monogram: "X", presets: [{ kpi: "absent", label: "?" }], collect: undefined };
  const v = (await checkContract(bad, fx)).join(" | ");
  assert.match(v, /2 lettres/); assert.match(v, /KPI absent inconnu/); assert.match(v, /sans collect/);
});

test("runTest : échec fournisseur → résultat propre, secret remplacé par •••, jamais d'exception", async () => {
  const leaky: Connector = { ...good, async test(c) { throw new Error(`401 pour la clé ${c.secrets.key}`); } };
  const r = await runTest(leaky, cfg, undefined);
  assert.equal(r.ok, false);
  assert.match(r.error!, /•••/); assert.doesNotMatch(r.error!, /SECRET_1234/);
  const typed: Connector = { ...good, async test() { throw new ConnectorError("auth", "Démo refuse cette clé"); } };
  assert.equal((await runTest(typed, cfg)).failure, "auth");
});

test("runTest : délai dépassé → message « ne répond pas », failure timeout", async () => {
  const slow: Connector = { ...good, test: () => new Promise(() => {}) };
  const ctx = { timeoutMs: 30 } as Ctx; // seul le délai est utile ici
  const r = await runTest(slow, cfg, { ...(await import("./registry.ts")).realCtx(), ...ctx });
  assert.equal(r.ok, false); assert.equal(r.failure, "timeout"); assert.equal(r.error, "Démo ne répond pas. Réessayez dans un instant.");
});

test("runCollect : nombre attendu, erreurs nettoyées, KPI inconnu refusé", async () => {
  const ctx = (await import("./registry.ts")).realCtx({ fetch: (async (u: any) => new Response(JSON.stringify(String(u).endsWith("/v") ? { v: 5 } : {}))) as typeof fetch });
  assert.equal(await runCollect(good, cfg, "v", {}, undefined, ctx), 5);
  await assert.rejects(runCollect(good, cfg, "inconnu", {}, undefined, ctx), /ne fournit pas/);
  const nan = (await import("./registry.ts")).realCtx({ fetch: (async () => new Response(JSON.stringify({ v: "abc" }))) as typeof fetch });
  await assert.rejects(runCollect(good, cfg, "v", {}, undefined, nan), /pas renvoyé de nombre/);
  const leak: Connector = { ...good, async collect(c) { throw new Error(`erreur avec ${c.secrets.key}`); } };
  await assert.rejects(runCollect(leak, cfg, "v", {}, undefined, ctx), (e: any) => !e.message.includes("SECRET_1234") && e.message.includes("•••"));
});

// Chaque connecteur enregistré par l'application doit avoir une fixture et respecter le contrat.
test("contrat : tous les connecteurs de l'application", async () => {
  await import("./index.ts");
  for (const c of all()) {
    const f = FIXTURES[c.id];
    if (!c.builtin) assert.ok(f, `fixture manquante pour ${c.id} (server/connectors/fixtures.ts)`);
    assert.deepEqual(await checkContract(c, f ?? { cfg: { config: {}, secrets: {} } }), [], `contrat violé par ${c.id}`);
  }
});
