// Changement de machine : export par l'interface d'une instance A, import dans une instance B (autre SECRET, autres
// dossiers), connexions récupérées grâce à la phrase de passe, médias réécrits, puis retour à l'état d'avant.
// Commandes de secours en ligne de commande sur la même base.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { login, seed, startServer, tempDb } from "./test-server.ts";

test("export de A, import dans B, retour arrière ; commandes de secours", async () => {
  const ta = tempDb(), tb = tempDb();
  // Une connexion avec son jeton, chiffrée par le SECRET de A.
  seed(ta.path, `await import("@server/business.ts"); const { createConnection } = await import("@server/connections.ts");
    createConnection({ kind: "ntfy", label: "Alertes", config: { server: "https://ntfy.exemple.test" }, secrets: { topic: "searchtide-0123456789abcdef" } });`);
  const a = await startServer(ta.path, { MEDIA_DIR: join(ta.dir, "media"), BACKUP_DIR: join(ta.dir, "backups") });
  const b = await startServer(tb.path, { MEDIA_DIR: join(tb.dir, "media"), BACKUP_DIR: join(tb.dir, "backups"), SECRET: "z".repeat(40) });
  try {
    const ca = await login(a.base), cb = await login(b.base);
    const call = (base: string, cookie: string, path: string, body?: unknown, method = "POST") => fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    // Instance A : un projet, une publication avec média, une connexion avec jeton.
    const p = await (await call(a.base, ca, "/api/projects", { name: "Atelier", crm_key: "atelier" })).json();
    const pub = await (await call(a.base, ca, "/api/publications", { day: "2026-11-20", title: "Post A", project: "atelier" })).json();
    const up = await fetch(`${a.base}/api/publications/${pub.id}/media?name=photo.jpg`, { method: "POST", headers: { "content-type": "image/jpeg", Cookie: ca }, body: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]) });
    assert.equal(up.status, 201);

    assert.equal((await call(a.base, ca, "/api/export", { passphrase: "court" })).status, 400, "phrase trop courte");
    const exp = await call(a.base, ca, "/api/export", { passphrase: "une phrase solide" });
    assert.equal(exp.status, 200); assert.match(exp.headers.get("content-disposition") ?? "", /searchtide-export-.*\.tar\.gz/);
    const archive = Buffer.from(await exp.arrayBuffer());

    // Instance B : analyse (rien d'écrit), phrase vérifiée, import, données et médias retrouvés.
    await call(b.base, cb, "/api/projects", { name: "Projet local de B" });
    const prev = await (await fetch(`${b.base}/api/import/preview`, { method: "POST", headers: { "content-type": "application/gzip", Cookie: cb }, body: archive })).json();
    assert.equal(prev.secrets, "phrase-requise"); assert.equal(prev.tables.projects, 1); assert.equal(prev.current.projects, 1);
    assert.equal((await (await call(b.base, cb, `/api/import/${prev.id}/check`, { passphrase: "fausse phrase" })).json()).secrets, "phrase-fausse");
    assert.equal((await (await call(b.base, cb, "/api/projects", undefined, "GET")).json()).length, 1, "l'analyse n'a rien écrit");
    const r = await (await call(b.base, cb, `/api/import/${prev.id}/apply`, { mode: "remplacer", passphrase: "une phrase solide" })).json();
    assert.ok(r.snapshot, JSON.stringify(r));
    const projects = await (await call(b.base, cb, "/api/projects", undefined, "GET")).json();
    assert.deepEqual(projects.map((x: any) => x.name), ["Atelier"]);
    const media = await (await call(b.base, cb, `/api/publications/${pub.id}/media`, undefined, "GET")).json();
    assert.equal(media.length, 1);
    const file = await fetch(`${b.base}/api/media/${media[0].id}`, { headers: { Cookie: cb } });
    assert.equal(file.status, 200, "le média est servi depuis le dossier de B");
    const conns = await (await call(b.base, cb, "/api/connections", undefined, "GET")).json();
    const nt = conns.list.find((x: any) => x.kind === "ntfy");
    assert.ok(nt && nt.status !== "reconnect", "jeton rechiffré pour B : connexion utilisable");

    // Retour à l'état d'avant l'import.
    const snaps = await (await call(b.base, cb, "/api/import/snapshots", undefined, "GET")).json();
    assert.ok(snaps.length >= 1);
    assert.equal((await call(b.base, cb, "/api/import/undo", { name: snaps[snaps.length - 1].name })).status, 200);
    assert.deepEqual((await (await call(b.base, cb, "/api/projects", undefined, "GET")).json()).map((x: any) => x.name), ["Projet local de B"]);
    assert.equal((await fetch(`${b.base}/api/export`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer cle-api-de-test-0001" }, body: "{}" })).status, 403, "une clé d'API n'exporte pas");
    void p;
  } finally { a.stop(); b.stop(); }

  // Commandes de secours sur la base de A (serveur arrêté).
  const dir = mkdtempSync(join(tmpdir(), "st-cli-"));
  try {
    const env = { ...process.env, DATABASE_PATH: ta.path, SECRET: "h".repeat(40), MEDIA_DIR: join(ta.dir, "media"), BACKUP_DIR: join(ta.dir, "backups"), EXPORT_PASSPHRASE: "une phrase solide" };
    const out = join(dir, "cli.tar.gz");
    const e = execFileSync(process.execPath, ["--no-warnings", "scripts/exporter.mjs", out], { env, encoding: "utf8" });
    assert.match(e, /Export écrit/); assert.ok(existsSync(out));
    const i = execFileSync(process.execPath, ["--no-warnings", "scripts/importer.mjs", out, "--mode", "fusionner", "--oui"], { env, encoding: "utf8" });
    assert.match(i, /Import terminé/); assert.match(i, /Pour revenir en arrière/);
    writeFileSync(join(dir, "faux.tar.gz"), "pas une archive");
    assert.throws(() => execFileSync(process.execPath, ["--no-warnings", "scripts/importer.mjs", join(dir, "faux.tar.gz"), "--oui"], { env, stdio: "pipe" }), /rien n'a été modifié/);
  } finally { rmSync(dir, { recursive: true, force: true }); ta.done(); tb.done(); }
});
