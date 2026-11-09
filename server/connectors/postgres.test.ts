// Tests T14 (CA16) : connecteur Postgres en lecture seule. Ici : base SIMULÉE (garde-fous, protocole, messages).
// Le test contre un vrai Postgres est dans postgres.real.test.ts (activé avec SEARCHTIDE_TEST_PG).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { db } from "../db.ts";
import { markAdmin } from "../admin.ts";
import { connections } from "../connections.ts";
import { registerConnections, setConnectorContext } from "./api.ts";
import { setCollectContext } from "./use.ts";
import { checkSql, statementSeparators, pgQuery } from "./postgres.ts";
import { get, realCtx, runTest } from "./registry.ts";
import { checkContract } from "./contract.ts";
import { FIXTURES } from "./fixtures.ts";
import { measure, saveIndicator, saveProject } from "../projects.ts";
import type { PgPoolLike } from "./types.ts";
import "./index.ts";

process.env.SECRET = "t".repeat(40);
const URL_RO = "postgres://searchtide_ro:" + "Sup3rMotDePasse9x@db.exemple.test:5432/produit";
const log: { sql: string; params?: unknown[] }[] = []; let ended = 0, released = 0;
let who: Record<string, any> = { u: "searchtide_ro", d: "produit", v: "PostgreSQL 16.2 on x86_64", su: false }; let canWrite = false;
let failWith: any = null; let answer: any[] = [{ count: "42" }]; let connectError: any = null;
const pool: PgPoolLike = {
  connect: async () => { if (connectError) throw connectError; return { query: async (sql: string, params?: unknown[]) => {
    log.push({ sql, params });
    if (/^(BEGIN|SET|ROLLBACK)/i.test(sql)) return { rows: [] };
    if (failWith && !/current_user AS u|can_write/.test(sql)) throw failWith;
    if (/current_user AS u/.test(sql)) return { rows: [who] };
    if (/can_write/.test(sql)) return { rows: [{ can_write: canWrite }] };
    return { rows: answer };
  }, release() { released++; } }; },
  end: async () => { ended++; },
};
const sim = realCtx({ pg: () => pool, now: () => new Date("2026-11-09T10:00:00Z") });
const admin = new Hono(); admin.use("*", (c, n) => { markAdmin(c); return n(); }); registerConnections(admin);
const post = (body: unknown) => admin.request("/api/connections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
beforeEach(() => { log.length = 0; ended = 0; released = 0; failWith = null; connectError = null; answer = [{ count: "42" }]; canWrite = false;
  who = { u: "searchtide_ro", d: "produit", v: "PostgreSQL 16.2 on x86_64", su: false }; delete process.env.MA_BASE; process.env.SECRET = "t".repeat(40);
  db.exec("DELETE FROM connections"); setConnectorContext(sim); setCollectContext(sim); });

test("contrat commun : le connecteur Postgres est conforme", async () => {
  assert.deepEqual(await checkContract(get("postgres")!, FIXTURES.postgres), []);
});

test("garde-fou SQL : un SELECT/WITH seul passe, y compris avec « ; » dans une chaîne, un commentaire ou un dollar-quoting", () => {
  for (const ok of [
    "SELECT 1", "  select count(*) from users", "WITH a AS (SELECT 1) SELECT * FROM a", "(SELECT 1)", "VALUES (1)",
    "SELECT 'a;b'", "SELECT \"col;umn\" FROM t", "SELECT $$x;y$$", "SELECT $tag$ ; $tag$", "SELECT 1 -- ; commentaire\n",
    "/* ; */ SELECT 1", "SELECT E'it\\'s;ok'", "SELECT 'l''apostrophe;'", "SELECT count(*) FROM t WHERE d >= $1::date",
  ]) assert.doesNotThrow(() => checkSql(ok), ok);
});

test("CA16 : INSERT/UPDATE/DELETE/DDL et deux instructions séparées par « ; » sont refusés", () => {
  for (const bad of ["INSERT INTO t VALUES (1)", "UPDATE t SET a = 1", "DELETE FROM t", "DROP TABLE t", "TRUNCATE t", "CREATE TABLE x (a int)", "COPY t TO '/tmp/x'", "CALL p()", "DO $$ BEGIN END $$", "SET ROLE x", "BEGIN"])
    assert.throws(() => checkSql(bad), /Seules les requêtes SELECT/, bad);
  for (const multi of ["SELECT 1; SELECT 2", "SELECT 1;", "SELECT 1; DROP TABLE t", "SELECT 1 ;\nDELETE FROM t", "SELECT 'x'; SELECT 'y'", "SELECT $$a$$; SELECT 1", "SELECT 1 /* c */ ; SELECT 2", "SELECT E'\\\\'; DROP TABLE t"])
    assert.throws(() => checkSql(multi), /sans point-virgule/, multi);
  assert.throws(() => checkSql("   "), /vide/);
  assert.deepEqual(statementSeparators("SELECT 1; SELECT ';'; SELECT 3"), [8, 20]);
});

test("exécution : BEGIN READ ONLY, délai de 10 s, paramètre $1, ROLLBACK, connexion libérée et fermée", async () => {
  const v = await pgQuery(URL_RO, "SELECT COUNT(*) FROM users WHERE created_at >= $1::date", "2026-11-09", sim);
  assert.equal(v, 42);
  assert.deepEqual(log.map((l) => l.sql), ["BEGIN READ ONLY", "SET LOCAL statement_timeout = '10s'", "SELECT COUNT(*) FROM users WHERE created_at >= $1::date", "ROLLBACK"]);
  assert.deepEqual(log[2].params, ["2026-11-09"]);
  await pgQuery(URL_RO, "SELECT 1", undefined, sim);
  assert.deepEqual(log.at(-2)!.params, [], "sans $1, aucun paramètre");
  assert.equal(released, 2); assert.equal(ended, 2);
  log.length = 0;
  await assert.rejects(pgQuery(URL_RO, "INSERT INTO t VALUES (1)", undefined, sim), /Seules les requêtes SELECT/);
  assert.equal(log.length, 0, "refusée avant toute connexion");
});

test("erreurs de la base : écriture refusée par le serveur (25006), 10 s dépassées (57014), identifiants, injoignable", async () => {
  failWith = Object.assign(new Error("cannot execute INSERT in a read-only transaction"), { code: "25006" });
  await assert.rejects(pgQuery(URL_RO, "WITH x AS (INSERT INTO t VALUES (1) RETURNING 1) SELECT * FROM x", undefined, sim), /essaie d'écrire/);
  assert.equal(log.at(-1)!.sql, "ROLLBACK"); assert.equal(released, 1);
  failWith = Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
  await assert.rejects(pgQuery(URL_RO, "SELECT pg_sleep(12)", undefined, sim), /dépasse 10 secondes/);
  failWith = Object.assign(new Error("permission denied for table users"), { code: "42501" });
  await assert.rejects(pgQuery(URL_RO, "SELECT 1 FROM users", undefined, sim), /GRANT SELECT/);
  failWith = null; answer = [{ count: "abc" }];
  await assert.rejects(pgQuery(URL_RO, "SELECT 'abc'", undefined, sim), /doit renvoyer un nombre/);
  connectError = Object.assign(new Error("password authentication failed"), { code: "28P01" });
  await assert.rejects(pgQuery(URL_RO, "SELECT 1", undefined, sim), /refuse ces identifiants/);
  connectError = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  await assert.rejects(pgQuery(URL_RO, "SELECT 1", undefined, sim), /Connexion impossible à db\.exemple\.test:5432/);
});

test("CA16 : un compte superutilisateur est refusé au test (rien d'enregistré) avec le message prévu", async () => {
  who = { ...who, u: "postgres", su: true };
  const r = await post({ kind: "postgres", values: { url: URL_RO } });
  assert.equal(r.status, 400); assert.equal((await r.json()).error, "Compte superutilisateur refusé : créez un compte en lecture seule.");
  assert.equal(connections().length, 0);
  assert.equal(log.filter((l) => /INSERT|CREATE|UPDATE/i.test(l.sql)).length, 0);
});

test("compte en lecture seule : enregistré sans avertissement ; compte qui peut écrire : enregistré AVEC avertissement", async () => {
  const ok = await post({ kind: "postgres", label: "Base produit", values: { url: URL_RO } });
  const text = await ok.text();
  assert.equal(ok.status, 201, text);
  assert.doesNotMatch(text, /Sup3rMotDePasse9x/);
  const j = JSON.parse(text);
  assert.deepEqual(j.test.warnings, []); assert.equal(j.test.detail, "base produit, PostgreSQL 16, compte searchtide_ro");
  assert.equal(j.connection.hint, "searchtide_ro@db.exemple.test:5432/produit"); assert.equal(j.connection.label, "Base produit");
  assert.deepEqual(log.slice(0, 2).map((l) => l.sql), ["BEGIN READ ONLY", "SET LOCAL statement_timeout = '10s'"], "même le test se fait en lecture seule");
  canWrite = true;
  const w = await post({ kind: "postgres", label: "Base 2", values: { url: URL_RO.replace("Sup3r", "Autre") } });
  assert.equal(w.status, 201);
  assert.deepEqual((await w.json()).test.warnings, ["Ce compte peut écrire : utilisez un compte en lecture seule (modèle dans le guide)."]);
  assert.equal(connections().length, 2, "plusieurs bases possibles");
});

test("URL invalide, mauvais mot de passe, base injoignable, délai : messages clairs, aucune ligne", async () => {
  assert.match((await (await post({ kind: "postgres", values: { url: "mysql://a:" + "b@h/d" } })).json()).error, /commencer par postgres:\/\//);
  assert.match((await (await post({ kind: "postgres", values: { url: "pas une url" } })).json()).error, /ressembler à postgres/);
  connectError = Object.assign(new Error("password authentication failed"), { code: "28P01" });
  assert.match((await (await post({ kind: "postgres", values: { url: URL_RO } })).json()).error, /PostgreSQL refuse ces identifiants/);
  connectError = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  assert.match((await (await post({ kind: "postgres", values: { url: URL_RO } })).json()).error, /Connexion impossible/);
  connectError = null;
  const hang = realCtx({ timeoutMs: 40, pg: () => ({ connect: () => new Promise(() => {}), end: async () => {} }) });
  const r = await runTest(get("postgres")!, { config: {}, secrets: { url: URL_RO } }, hang);
  assert.equal(r.failure, "timeout"); assert.equal(r.error, "La base de données ne répond pas. Réessayez dans un instant.");
  assert.equal(connections().length, 0);
});

test("indicateurs : INSERT ou deux instructions refusés à l'enregistrement ; relevé via la connexion (jour passé en $1) ; ancien mode env gardé", async () => {
  const p = saveProject(null, { name: "Produit" })!;
  assert.throws(() => saveIndicator(null, p.id, { label: "x", mode: "total", source: "pg", config: { sql: "INSERT INTO t VALUES (1)" } }), /Seules les requêtes SELECT/);
  assert.throws(() => saveIndicator(null, p.id, { label: "x", mode: "total", source: "pg", config: { sql: "SELECT 1; SELECT 2" } }), /sans point-virgule/);
  await post({ kind: "postgres", values: { url: URL_RO } });
  const daily = saveIndicator(null, p.id, { label: "Inscriptions", mode: "daily", source: "pg", config: { sql: "SELECT COUNT(*) FROM users WHERE created_at >= $1::date" } })!;
  const total = saveIndicator(null, p.id, { label: "Utilisateurs", mode: "total", source: "pg", config: { sql: "SELECT COUNT(*) FROM users" } })!;
  log.length = 0;
  assert.equal(await measure(daily, "2026-11-09"), 42);
  assert.deepEqual(log.find((l) => l.sql.startsWith("SELECT COUNT"))!.params, ["2026-11-09"]);
  assert.equal(await measure(total), 42);
  // ancien mode : la variable désigne l'URL ; mêmes garde-fous
  process.env.MA_BASE = URL_RO;
  const legacy = saveIndicator(null, p.id, { label: "Ancien", mode: "total", source: "pg", config: { env: "MA_BASE", sql: "SELECT COUNT(*) FROM users" } })!;
  log.length = 0; assert.equal(await measure(legacy), 42); assert.equal(log[0].sql, "BEGIN READ ONLY");
});

test("compte ou clé révoqués pendant un relevé → la connexion passe en « à reconnecter »", async () => {
  const c = await (await post({ kind: "postgres", values: { url: URL_RO } })).json();
  const p = saveProject(null, { name: "Révoqué" })!;
  const ind = saveIndicator(null, p.id, { label: "n", mode: "total", source: "pg", config: { sql: "SELECT COUNT(*) FROM users" } })!;
  connectError = Object.assign(new Error("password authentication failed"), { code: "28P01" });
  await assert.rejects(measure(ind), /refuse ces identifiants/);
  assert.equal(connections().find((x) => x.id === c.connection.id)!.status, "reconnect");
});
