// Export / import (format ouvert) : aller-retour fidèle, secrets protégés par phrase de passe, fusion, archive abîmée,
// version plus récente refusée, transaction annulée en cas d'erreur, chemins hors de l'archive refusés.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, createReadStream, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
const root = mkdtempSync(join(tmpdir(), "st-portable-"));
process.env.SECRET ??= "secret-de-test-".repeat(4);
process.env.MEDIA_DIR = join(root, "media");
process.env.BACKUP_DIR = join(root, "backups");
import { db } from "./db.ts";
import "./business.ts";
import "./publishers/queue.ts";
import { createConnection, getSecrets } from "./connections.ts";
import { applyExport, createExport, openExport, previewExport, tarIndex, TarWriter, readEntry, safetySnapshot } from "./portable.ts";

const work = join(root, "travail");
const count = (t: string, where = "1") => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${where}`).get() as any).n);
db.prepare("INSERT INTO projects (id, name, crm_key, created_at) VALUES ('p1', 'Atelier', 'atelier', 0)").run();
db.prepare("INSERT INTO contacts (id, name, email, stage, project, created_at, updated_at) VALUES ('c1', 'Léa \"la cliente\", Paris', 'lea@x.fr', 'lead', 'atelier', 0, 0)").run();
const conn = createConnection({ kind: "stripe", label: "Stripe", secrets: { key: "rk_test_ABC123" } } as any);
db.prepare("INSERT INTO publications (id, day, title, project, status, created_at, updated_at) VALUES ('pub1', '2026-11-20', 'Post', 'atelier', 'idea', 0, 0)").run();
mkdirSync(join(process.env.MEDIA_DIR!, "pub1"), { recursive: true });
const mediaFile = join(process.env.MEDIA_DIR!, "pub1", "photo");
writeFileSync(mediaFile, Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]));
db.prepare("INSERT INTO pub_media (id, publication_id, name, mime, size, path, created_at) VALUES ('m1', 'pub1', 'photo.jpg', 'image/jpeg', 6, ?, 0)").run(mediaFile);

/** Réécrit une archive en modifiant un fichier (et, si demandé, son empreinte dans le manifeste). */
async function repack(src: string, dest: string, edit: (name: string, data: Buffer) => Buffer, fixHash = false) {
  const tar = join(work, "re.tar"); mkdirSync(work, { recursive: true });
  await pipeline(createReadStream(src), createGunzip(), createWriteStream(tar));
  const idx = tarIndex(tar), out = join(work, "out.tar"), tw = new TarWriter(out);
  const files: Record<string, Buffer> = {};
  for (const [n, e] of idx) files[n] = edit(n, readEntry(tar, e));
  if (fixHash) { const m = JSON.parse(files["manifest.json"].toString()); const { createHash } = await import("node:crypto");
    for (const n of Object.keys(m.files)) m.files[n] = createHash("sha256").update(files[n]).digest("hex"); files["manifest.json"] = Buffer.from(JSON.stringify(m)); }
  for (const [n, b] of Object.entries(files)) tw.add(n, b);
  tw.close();
  await pipeline(createReadStream(out), createGzip(), createWriteStream(dest));
}

test("aller-retour avec phrase de passe : données, CSV, médias et jetons des connexions retrouvés", async () => {
  const file = join(root, "export.tar.gz");
  const { manifest } = await createExport(file, { passphrase: "phrase de passe longue" });
  assert.equal(manifest.secrets, "phrase"); assert.equal(manifest.media.files, 1);
  const x0 = await openExport(file, work);
  try {
    assert.ok(x0.index.has("csv/contacts.csv") && x0.index.has("tables/projects.ndjson") && x0.index.has("media/pub1/photo"));
    assert.match(readEntry(x0.tar, x0.index.get("csv/contacts.csv")!).toString(), /"Léa ""la cliente"", Paris"/);
    assert.ok(!readEntry(x0.tar, x0.index.get("tables/connections.ndjson")!).toString().includes("rk_test_ABC123"), "jeton jamais en clair");
  } finally { x0.close(); }
  // Tout casse : projet supprimé, contact modifié, média perdu, jetons effacés.
  db.prepare("DELETE FROM projects").run(); db.prepare("UPDATE contacts SET name = 'abîmé'").run(); rmSync(mediaFile);
  db.prepare("UPDATE connections SET secrets = NULL").run();
  const x = await openExport(file, work);
  try {
    assert.equal(previewExport(x).secrets, "phrase-requise");
    assert.equal(previewExport(x, "mauvaise phrase").secrets, "phrase-fausse");
    assert.equal(previewExport(x, "phrase de passe longue").secrets, "phrase-ok");
    applyExport(x, { mode: "remplacer", passphrase: "phrase de passe longue" });
  } finally { x.close(); }
  assert.equal(count("projects", "id = 'p1'"), 1);
  assert.equal((db.prepare("SELECT name FROM contacts WHERE id = 'c1'").get() as any).name, 'Léa "la cliente", Paris');
  assert.deepEqual(getSecrets(conn.id), { key: "rk_test_ABC123" });
  assert.deepEqual(readFileSync(mediaFile), Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]));
});

test("sans phrase de passe : jetons retirés du fichier, connexions marquées « à reconnecter »", async () => {
  const file = join(root, "sans.tar.gz");
  await createExport(file);
  const x = await openExport(file, work);
  try { assert.equal(previewExport(x).secrets, "aucun"); applyExport(x, { mode: "remplacer" }); } finally { x.close(); }
  const c = db.prepare("SELECT secrets, status, status_detail FROM connections WHERE id = ?").get(conn.id) as any;
  assert.equal(c.secrets, null); assert.equal(c.status, "reconnect"); assert.match(c.status_detail, /reconnectez/);
});

test("fusion : les enregistrements existants sont gardés, seuls les absents sont ajoutés", async () => {
  const file = join(root, "fusion.tar.gz");
  db.prepare("INSERT INTO contacts (id, name, stage, created_at, updated_at) VALUES ('c2', 'Paul', 'lead', 0, 0)").run();
  await createExport(file);
  db.prepare("UPDATE contacts SET name = 'Léa modifiée' WHERE id = 'c1'").run();
  db.prepare("DELETE FROM contacts WHERE id = 'c2'").run();
  db.prepare("INSERT INTO contacts (id, name, stage, created_at, updated_at) VALUES ('c3', 'Nouveau', 'lead', 0, 0)").run();
  const x = await openExport(file, work);
  try { applyExport(x, { mode: "fusionner" }); } finally { x.close(); }
  assert.equal((db.prepare("SELECT name FROM contacts WHERE id = 'c1'").get() as any).name, "Léa modifiée", "existant non écrasé");
  assert.equal(count("contacts", "id IN ('c2', 'c3')"), 2, "absent ajouté, nouveau gardé");
});

test("archive abîmée ou d'une version plus récente : refusée avant toute écriture", async () => {
  const file = join(root, "base.tar.gz"); await createExport(file);
  const bad = join(root, "abimee.tar.gz");
  await repack(file, bad, (n, b) => n === "tables/contacts.ndjson" ? Buffer.from(b.toString().replace("lead", "won")) : b);
  await assert.rejects(openExport(bad, work), /abîmée/);
  const newer = join(root, "recente.tar.gz");
  await repack(file, newer, (n, b) => n === "manifest.json" ? Buffer.from(JSON.stringify({ ...JSON.parse(b.toString()), migrations: [...JSON.parse(b.toString()).migrations, "2099-01-01-futur"] })) : b);
  const x = await openExport(newer, work);
  try { assert.throws(() => applyExport(x, { mode: "remplacer" }), /version plus récente/); } finally { x.close(); }
  await assert.rejects(openExport(join(root, "media", "pub1", "photo"), work), /pas un export Searchtide/);
});

test("erreur au milieu de l'import : transaction annulée, rien n'a changé", async () => {
  const file = join(root, "base2.tar.gz"); await createExport(file);
  const broken = join(root, "casse.tar.gz");
  // Un contact sans « name » (colonne obligatoire) : l'import échoue après avoir vidé et réécrit d'autres tables.
  await repack(file, broken, (n, b) => n === "tables/contacts.ndjson" ? Buffer.from(b.toString() + JSON.stringify({ id: "cx", stage: "lead", created_at: 0, updated_at: 0 }) + "\n") : b, true);
  const before = count("contacts"), projects = count("projects");
  const x = await openExport(broken, work);
  try { assert.throws(() => applyExport(x, { mode: "remplacer" }), /obligatoire/); } finally { x.close(); }
  assert.equal(count("contacts"), before); assert.equal(count("projects"), projects);
});

test("instantané avant import : relisible sur la même instance avec ses jetons", async () => {
  const snap = await safetySnapshot();
  assert.ok(existsSync(snap));
  const x = await openExport(snap, work);
  try { assert.equal(previewExport(x).secrets, "coffre-ok"); } finally { x.close(); }
});

test("archive piégée : un chemin qui sort de l'archive est refusé", () => {
  const f = join(work, "piege.tar"); mkdirSync(work, { recursive: true });
  const tw = new TarWriter(f); tw.add("media/../../etc/passwd", "x"); tw.close();
  assert.throws(() => tarIndex(f), /Chemin refusé/);
});

test.after(() => rmSync(root, { recursive: true, force: true }));
