// T14, CA16 contre un VRAI Postgres. Désactivé par défaut (aucune base requise pour `npm test`).
// Lancer avec une base jetable :
//   docker run -d --rm --name pg-test -e POSTGRES_PASSWORD=mot-de-passe -p 127.0.0.1:55432:5432 postgres:17-alpine
//   SEARCHTIDE_TEST_PG=postgres://postgres:<mot de passe>@127.0.0.1:55432/postgres npm test
// Le test crée une base « st_t14 » et deux rôles (st_ro, st_rw), puis les supprime.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { Hono } from "hono";
import { markAdmin } from "../admin.ts";
import { connections } from "../connections.ts";
import { db } from "../db.ts";
import { registerConnections, setConnectorContext } from "./api.ts";
import { setCollectContext } from "./use.ts";
import { pgQuery } from "./postgres.ts";
import { get, realCtx, runTest } from "./registry.ts";
import "./index.ts";

const ADMIN = process.env.SEARCHTIDE_TEST_PG;
const skip = ADMIN ? false : "SEARCHTIDE_TEST_PG non défini : test Postgres réel ignoré";
process.env.SECRET = "t".repeat(40);
const RO_PW = "RoJetable_Pw_7731", RW_PW = "RwJetable_Pw_5519";
const withDb = (url: string, user?: string, pw?: string, database = "st_t14") => { const u = new URL(url); if (user) { u.username = user; u.password = pw ?? ""; } u.pathname = `/${database}`; return u.toString(); };
let admin: pg.Client; let urls: { su: string; ro: string; rw: string };
const ctx = realCtx();
const count = async () => Number((await admin.query("SELECT COUNT(*) AS n FROM evt")).rows[0].n);

before(async () => {
  if (skip) return;
  const root = new pg.Client({ connectionString: ADMIN! }); await root.connect();
  await root.query("DROP DATABASE IF EXISTS st_t14"); await root.query("DROP ROLE IF EXISTS st_ro"); await root.query("DROP ROLE IF EXISTS st_rw");
  await root.query("CREATE DATABASE st_t14"); await root.end();
  admin = new pg.Client({ connectionString: withDb(ADMIN!) }); await admin.connect();
  await admin.query("CREATE TABLE evt (id serial PRIMARY KEY, n int NOT NULL); INSERT INTO evt (n) VALUES (1), (2), (3)");
  await admin.query(`CREATE ROLE st_ro LOGIN PASSWORD '${RO_PW}'; GRANT CONNECT ON DATABASE st_t14 TO st_ro; GRANT USAGE ON SCHEMA public TO st_ro; GRANT SELECT ON ALL TABLES IN SCHEMA public TO st_ro;`);
  await admin.query(`CREATE ROLE st_rw LOGIN PASSWORD '${RW_PW}'; GRANT CONNECT ON DATABASE st_t14 TO st_rw; GRANT USAGE ON SCHEMA public TO st_rw; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO st_rw; GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO st_rw;`);
  urls = { su: withDb(ADMIN!), ro: withDb(ADMIN!, "st_ro", RO_PW), rw: withDb(ADMIN!, "st_rw", RW_PW) };
  setConnectorContext(undefined); setCollectContext(undefined);
});
after(async () => {
  if (skip) return;
  await admin.end();
  const root = new pg.Client({ connectionString: ADMIN! }); await root.connect();
  await root.query("DROP DATABASE IF EXISTS st_t14 WITH (FORCE)"); await root.query("DROP ROLE IF EXISTS st_ro"); await root.query("DROP ROLE IF EXISTS st_rw"); await root.end();
});

test("réel : un compte superutilisateur est refusé au test", { skip }, async () => {
  const r = await runTest(get("postgres")!, { config: {}, secrets: { url: urls.su } }, ctx);
  assert.equal(r.ok, false); assert.equal(r.error, "Compte superutilisateur refusé : créez un compte en lecture seule.");
});

test("réel : un compte en lecture seule est accepté sans avertissement ; un compte qui peut écrire, avec avertissement", { skip }, async () => {
  const ro = await runTest(get("postgres")!, { config: {}, secrets: { url: urls.ro } }, ctx);
  assert.equal(ro.ok, true, ro.error ?? ""); assert.deepEqual(ro.warnings, []); assert.match(ro.detail!, /base st_t14, PostgreSQL 17, compte st_ro/);
  const rw = await runTest(get("postgres")!, { config: {}, secrets: { url: urls.rw } }, ctx);
  assert.equal(rw.ok, true, rw.error ?? ""); assert.deepEqual(rw.warnings, ["Ce compte peut écrire : utilisez un compte en lecture seule (modèle dans le guide)."]);
});

test("réel : un SELECT s'exécute ; le paramètre $1 reçoit le jour", { skip }, async () => {
  assert.equal(await pgQuery(urls.ro, "SELECT COUNT(*) FROM evt", undefined, ctx), 3);
  assert.equal(await pgQuery(urls.ro, "SELECT COUNT(*) FROM evt WHERE $1::date = DATE '2026-11-09'", "2026-11-09", ctx), 3);
});

test("CA16 réel : INSERT/UPDATE refusés ; une écriture cachée dans un WITH est refusée PAR LE SERVEUR même avec un compte qui a le droit d'écrire", { skip }, async () => {
  await assert.rejects(pgQuery(urls.rw, "INSERT INTO evt (n) VALUES (9)", undefined, ctx), /Seules les requêtes SELECT/);
  await assert.rejects(pgQuery(urls.rw, "UPDATE evt SET n = 0", undefined, ctx), /Seules les requêtes SELECT/);
  await assert.rejects(pgQuery(urls.rw, "WITH x AS (INSERT INTO evt (n) VALUES (9) RETURNING 1) SELECT COUNT(*) FROM x", undefined, ctx), /essaie d'écrire/);
  await assert.rejects(pgQuery(urls.rw, "WITH x AS (UPDATE evt SET n = 0 RETURNING 1) SELECT COUNT(*) FROM x", undefined, ctx), /essaie d'écrire/);
  await assert.rejects(pgQuery(urls.rw, "WITH x AS (DELETE FROM evt RETURNING 1) SELECT COUNT(*) FROM x", undefined, ctx), /essaie d'écrire/);
  assert.equal(await count(), 3, "aucune ligne n'a été ajoutée, modifiée ou supprimée");
  assert.equal(Number((await admin.query("SELECT COALESCE(SUM(n), 0) AS s FROM evt")).rows[0].s), 6);
});

test("CA16 réel : deux instructions refusées par le garde-fou ; et si le garde-fou était contourné, le serveur refuse l'écriture (transaction en lecture seule)", { skip }, async () => {
  await assert.rejects(pgQuery(urls.rw, "SELECT 1; INSERT INTO evt (n) VALUES (7)", undefined, ctx), /sans point-virgule/);
  // contournement simulé : on envoie nous-mêmes les deux instructions dans une transaction en lecture seule, avec le compte qui peut écrire
  const raw = new pg.Client({ connectionString: urls.rw }); await raw.connect();
  try {
    await raw.query("BEGIN READ ONLY", []);
    await assert.rejects(raw.query("SELECT 1; INSERT INTO evt (n) VALUES (7)", []), /read-only transaction/);
    await raw.query("ROLLBACK", []);
  } finally { await raw.end(); }
  assert.equal(await count(), 3);
});

test("CA16 réel : une requête de plus de 10 s est interrompue", { skip, timeout: 40_000 }, async () => {
  const t0 = Date.now();
  await assert.rejects(pgQuery(urls.ro, "SELECT pg_sleep(30)", undefined, ctx), /dépasse 10 secondes/);
  const s = (Date.now() - t0) / 1000;
  assert.ok(s >= 9.5 && s < 14, `interrompue après ${s.toFixed(1)} s`);
});

test("réel : mauvais mot de passe, base injoignable", { skip }, async () => {
  await assert.rejects(pgQuery(withDb(ADMIN!, "st_ro", "mauvais"), "SELECT 1", undefined, ctx), /refuse ces identifiants/);
  const dead = new URL(urls.ro); dead.port = "1";
  await assert.rejects(pgQuery(dead.toString(), "SELECT 1", undefined, ctx), /Connexion impossible/);
});

test("réel, de bout en bout par l'API : superutilisateur → 400 ; compte en lecture seule → 201, mot de passe jamais renvoyé", { skip }, async () => {
  const app = new Hono(); app.use("*", (c, n) => { markAdmin(c); return n(); }); registerConnections(app);
  const post = (url: string) => app.request("/api/connections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "postgres", values: { url } }) });
  db.exec("DELETE FROM connections");
  const su = await post(urls.su);
  assert.equal(su.status, 400); assert.match((await su.json()).error, /superutilisateur refusé/); assert.equal(connections().length, 0);
  const ok = await post(urls.ro); const text = await ok.text();
  assert.equal(ok.status, 201, text); assert.doesNotMatch(text, new RegExp(RO_PW));
  assert.equal(JSON.parse(text).connection.hint, `st_ro@${new URL(urls.ro).host}/st_t14`);
});
