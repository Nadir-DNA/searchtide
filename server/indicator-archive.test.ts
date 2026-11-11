// P1-A : le changement de source archive l'ancienne série, restauration et suppression définitive protégée.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARCHIVE_MIGRATION, collectAll, record, saveIndicator, saveProject } from "./projects.ts";
import { db } from "./db.ts";
import { login, seed, startServer, tempDb } from "./test-server.ts";

test("P1-A : migration additive sur ancien schéma (colonnes archivées nullables)", () => {
  const dir = mkdtempSync(join(tmpdir(), "st-arch-"));
  const db = new DatabaseSync(join(dir, "old.db"));
  try {
    db.exec("CREATE TABLE indicators (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, label TEXT NOT NULL, unit TEXT, mode TEXT NOT NULL, source TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}', position INTEGER NOT NULL DEFAULT 0, last_run INTEGER, last_error TEXT, created_at INTEGER NOT NULL)");
    db.prepare("INSERT INTO indicators (id, project_id, label, mode, source, created_at) VALUES ('i', 'p', 'Ventes', 'daily', 'manual', 0)").run();
    db.exec(ARCHIVE_MIGRATION);
    const row = db.prepare("SELECT archived_at, archived_from FROM indicators WHERE id = 'i'").get() as { archived_at: number | null; archived_from: string | null };
    assert.deepEqual({ ...row }, { archived_at: null, archived_from: null });
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("P1-A : changement de source → archive + annotation, restauration, suppression définitive", async () => {
  const t = tempDb();
  seed(t.path, `import "@server/projects.ts";
    const m = await import("@server/projects.ts");
    const { db } = await import("@server/db.ts");
    db.prepare("INSERT INTO projects (id, name, position, created_at) VALUES ('p-arch', 'Archive', 0, 0)").run();
    const ind = m.saveIndicator(null, "p-arch", { label: "Ventes", mode: "daily", source: "manual" });
    m.record(ind.id, "2026-01-01", 5); m.record(ind.id, "2026-01-02", 8); m.record(ind.id, "2026-01-03", 13);
    m.saveIndicator(ind.id, null, { source: "http", config: { url: "https://example.test", path: "v" } });`);
  const s = await startServer(t.path);
  try {
    const cookie = await login(s.base);
    const h = { Cookie: cookie, "content-type": "application/json" };
    const p = await (await fetch(`${s.base}/api/projects/p-arch`, { headers: h })).json();
    assert.equal(p.indicators.length, 1);
    const currentId = p.indicators[0].id;
    assert.equal(p.indicators[0].series.filter((x: any) => x.value != null).length, 0, "repart vide");
    const archives = await (await fetch(`${s.base}/api/projects/p-arch/archives`, { headers: h })).json();
    assert.equal(archives.length, 1);
    assert.match(archives[0].label, /Ventes — jusqu'au/);
    assert.equal(archives[0].series.length, 3, "série archivée exportable");
    const changes = await (await fetch(`${s.base}/api/indicators/${currentId}/changes`, { headers: h })).json();
    const src = changes.find((c: any) => c.field === "source");
    assert.deepEqual([src.actor, src.before, src.after], ["interface", "manual", "http"], "journal des modifications");
    assert.equal((await (await fetch(`${s.base}/api/projects/p-arch?days=400`, { headers: h })).json()).indicators[0].series.filter((x: any) => x.value != null).length, 0);
    const notes = await (await fetch(`${s.base}/api/annotations?project=p-arch&days=400`, { headers: h })).json();
    assert.ok(notes.some((n: any) => /Source changée : manual → http/.test(n.label)), "annotation de rupture");

    // Le courant reçoit aussi une valeur le même jour que l'archive : l'échange doit rester valide.
    assert.equal((await fetch(`${s.base}/api/indicators/${currentId}/value`, { method: "POST", headers: h, body: JSON.stringify({ day: "2026-01-02", value: 7 }) })).status, 200);
    assert.equal((await fetch(`${s.base}/api/indicators/${archives[0].id}/restore`, { method: "POST", headers: h })).status, 200);
    const restored = await (await fetch(`${s.base}/api/projects/p-arch?days=400`, { headers: h })).json();
    assert.deepEqual(restored.indicators[0].series.filter((x: any) => x.value != null).map((x: any) => x.value), [5, 8, 13]);
    const swapped = await (await fetch(`${s.base}/api/projects/p-arch/archives`, { headers: h })).json();
    assert.equal(swapped.length, 1, "le courant vide est archivé à son tour");
    assert.deepEqual(swapped[0].series.map((x: any) => x.value), [7], "la série courante part dans l'archive");
    // Double restauration enchaînée : rien ne se perd.
    assert.equal((await fetch(`${s.base}/api/indicators/${swapped[0].id}/restore`, { method: "POST", headers: h })).status, 200);
    const back = await (await fetch(`${s.base}/api/projects/p-arch?days=400`, { headers: h })).json();
    assert.deepEqual(back.indicators[0].series.filter((x: any) => x.value != null).map((x: any) => x.value), [7]);
    assert.equal((await (await fetch(`${s.base}/api/projects/p-arch/archives`, { headers: h })).json())[0].series.length, 3);
    // Une archive n'est jamais relevée.
    assert.equal((await fetch(`${s.base}/api/indicators/${swapped[0].id}/collect`, { method: "POST", headers: h })).status, 409);

    // Suppression définitive : nom exact exigé, administrateur seulement.
    assert.equal((await fetch(`${s.base}/api/indicators/${currentId}`, { method: "PATCH", headers: h, body: JSON.stringify({ source: "manual", config: {} }) })).status, 200);
    const again = await (await fetch(`${s.base}/api/projects/p-arch/archives`, { headers: h })).json();
    const target = again.find((a: any) => a.series.length > 0);
    assert.ok(target, "l'ancienne série A est archivée");
    assert.equal((await fetch(`${s.base}/api/indicators/${target.id}/permanent`, { method: "DELETE", headers: { Cookie: cookie, "content-type": "application/json" }, body: JSON.stringify({ confirm: "faux" }) })).status, 400);
    const key = { Authorization: "Bearer cle-api-de-test-0001", "content-type": "application/json" };
    assert.equal((await fetch(`${s.base}/api/indicators/${target.id}/permanent`, { method: "DELETE", headers: key, body: JSON.stringify({ confirm: target.label }) })).status, 403);
    assert.equal((await fetch(`${s.base}/api/indicators/${target.id}/permanent`, { method: "DELETE", headers: h, body: JSON.stringify({ confirm: target.label }) })).status, 200);
    assert.equal((await (await fetch(`${s.base}/api/projects/p-arch/archives`, { headers: h })).json()).length, 1);
  } finally { s.stop(); t.done(); }
});

test("P1-A : collectAll ignore les séries archivées", async () => {
  const p = saveProject(null, { name: "Collecte archives" })!;
  const ind = saveIndicator(null, p.id, { label: "Série", mode: "daily", source: "manual" })!;
  record(ind.id, "2026-01-01", 2);
  saveIndicator(ind.id, null, { source: "http", config: { url: "https://example.test", path: "v" } });
  const archive = db.prepare("SELECT id FROM indicators WHERE project_id = ? AND archived_at IS NOT NULL").get(p.id) as { id: string } | undefined;
  assert.ok(archive, "archive créée");
  const before = (db.prepare("SELECT COUNT(*) AS n FROM metrics WHERE indicator_id = ?").get(archive!.id) as { n: number }).n;
  await collectAll();
  const after = (db.prepare("SELECT COUNT(*) AS n FROM metrics WHERE indicator_id = ?").get(archive!.id) as { n: number }).n;
  assert.equal(after, before, "la série archivée reste identique");
});
