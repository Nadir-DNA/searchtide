// Masquage unique récursif et refus des secrets littéraux dans les configs d'indicateur.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hasSecretKey, hasUrlSecret, maskSecrets } from "./mask.ts";
import { saveIndicator, saveProject } from "./projects.ts";

test("maskSecrets : noms conservés, valeurs masquées, imbriqué/tableau, keyword intact", () => {
  const input = { url: "https://x", apiKey: "hunter2", token: "tok", password: "pw", nested: { authorization: "Bearer x", keyword: "mot" }, list: [{ secret: "s" }, { ok: 1 }] };
  const out = maskSecrets(input) as any;
  assert.deepEqual([out.apiKey, out.token, out.password], ["•••", "•••", "•••"]);
  assert.equal(out.nested.authorization, "•••");
  assert.equal(out.nested.keyword, "mot");
  assert.equal(out.list[0].secret, "•••");
  assert.equal(out.url, "https://x");
  assert.equal(JSON.stringify(out).includes("hunter2"), false);
  assert.equal(hasSecretKey(input), true);
  assert.equal(hasSecretKey({ keyword: "ok", url: "x" }), false);
  assert.equal((maskSecrets({ url: "https://user:LEAK@h.test/x?api_key=LEAKQ&ok=1" }) as any).url, "https://•••@h.test/x?api_key=•••&ok=1");
  assert.equal(hasSecretKey({ url: "https://user:pw@h.test/" }), false, "userinfo n'est pas un nom de clé");
  assert.equal(hasUrlSecret("https://user:pw@h.test/"), true);
  assert.equal(hasUrlSecret("https://h.test/?token=x"), true);
  assert.equal(hasUrlSecret("https://h.test/path"), false);
  assert.equal(hasUrlSecret("https://h.test/?%61pi_key=secret"), true, "paramètre percent-encodé");
  assert.equal(hasUrlSecret("https://h.test/#token=secret"), true, "fragment sensible");
  assert.equal(hasUrlSecret("https://h.test/?page=2&limit=10"), false, "URL légitime");
  assert.equal((maskSecrets({ url: "https://h.test/?%61pi_key=secret&page=2" }) as any).url.includes("secret"), false, "valeur encodée masquée");
  for (const q of ["client_secret", "refresh_token", "x-api-key", "authorization", "passwd", "private_key", "apiToken"]) assert.equal(hasUrlSecret(`https://h.test/?${q}=LEAK`), true, q);
  assert.equal(hasUrlSecret("https://h.test/?page=2&limit=10&keyword=seo"), false, "paramètres légitimes");
  const extra = maskSecrets({ bearer: "b", credentials: "c", access_token: "a", keyword: "k" }) as any;
  assert.deepEqual([extra.bearer, extra.credentials, extra.access_token, extra.keyword], ["•••", "•••", "•••", "k"]);
});

test("config d'indicateur : connection_id accepté pour chaque source à connexion", () => {
  const p = saveProject(null, { name: "Connexions" })!;
  const cases: [string, Record<string, unknown>][] = [
    ["pg", { sql: "SELECT 1", connection_id: "conn-1" }],
    ["supabase", { metric: "users_total", connection_id: "conn-1" }],
    ["stripe", { metric: "mrr", connection_id: "conn-1" }],
    ["http", { url: "https://x.test", path: "v", connection_id: "conn-1" }],
    ["pagespeed", { url: "https://x.test", metric: "performance", connection_id: "conn-1" }],
    ["play", { package: "com.x", metric: "rating", connection_id: "conn-1" }],
  ];
  for (const [source, config] of cases) assert.ok(saveIndicator(null, p.id, { label: source, mode: "daily", source, config }), source);
  const ind = saveIndicator(null, p.id, { label: "ordre", mode: "daily", source: "http", config: { url: "https://x.test", path: "v" } })!;
  assert.ok(saveIndicator(ind.id, null, { label: "ordre 2", config: { path: "v", url: "https://x.test" } }), "ordre des clés identique = config inchangée");
});

test("config d'indicateur : secret littéral refusé, imbriqué compris", () => {
  const p = saveProject(null, { name: "Secrets" })!;
  assert.throws(() => saveIndicator(null, p.id, { label: "X", mode: "daily", source: "http", config: { url: "https://x.test", apiKey: "hunter2" } }), /variable d'environnement/);
  assert.throws(() => saveIndicator(null, p.id, { label: "Y", mode: "daily", source: "http", config: { url: "https://x.test", nested: { token: "t" } } as any }), /variable d'environnement/);
  assert.throws(() => saveIndicator(null, p.id, { label: "Z", mode: "daily", source: "http", config: { url: "https://x.test", foo: "bar" } }), /Clé non reconnue/);
  assert.throws(() => saveIndicator(null, p.id, { label: "W", mode: "daily", source: "http", config: { url: "https://x.test", secretKey: "x" } }), /non reconnue|variable d'environnement/);
  assert.throws(() => saveIndicator(null, p.id, { label: "U1", mode: "daily", source: "http", config: { url: "https://user:pw@x.test/" } }), /variable d'environnement/);
  assert.throws(() => saveIndicator(null, p.id, { label: "U2", mode: "daily", source: "http", config: { url: "https://x.test/?api_key=abc" } }), /variable d'environnement/);
});
