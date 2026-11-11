// 1.1 : la migration last_hit s'applique à un ancien schéma (colonne absente) et remplit la dernière visite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAST_HIT_FILL_MIGRATION, LAST_HIT_MIGRATION } from "./collect.ts";

test("1.1 : migration d'un ancien schéma — colonne nullable puis MAX(ts) par site", () => {
  const dir = mkdtempSync(join(tmpdir(), "st-mig-"));
  const db = new DatabaseSync(join(dir, "old.db"));
  try {
    db.exec(`CREATE TABLE sites (id TEXT PRIMARY KEY, domain TEXT NOT NULL UNIQUE, name TEXT NOT NULL, gsc_property TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE events (id INTEGER PRIMARY KEY, site_id TEXT NOT NULL, ts INTEGER NOT NULL, day TEXT NOT NULL);`);
    db.prepare("INSERT INTO sites (id, domain, name, created_at) VALUES ('a', 'a.test', 'A', 0), ('b', 'b.test', 'B', 0)").run();
    db.prepare("INSERT INTO events (site_id, ts, day) VALUES ('a', 1000, '2026-01-01'), ('a', 3000, '2026-01-02'), ('b', 2000, '2026-01-01')").run();
    db.exec(LAST_HIT_MIGRATION);
    const rows = (db.prepare("SELECT id, last_hit FROM sites ORDER BY id").all() as { id: string; last_hit: number | null }[])
      .map((r) => ({ id: r.id, last_hit: r.last_hit }));
    assert.deepEqual(rows, [{ id: "a", last_hit: 3000 }, { id: "b", last_hit: 2000 }]);
    // Base déjà migrée mais non remplie (ancienne version) : la seconde migration rattrape et ajoute l'index.
    db.prepare("INSERT INTO sites (id, domain, name, created_at, last_hit) VALUES ('c', 'c.test', 'C', 0, NULL)").run();
    db.prepare("INSERT INTO events (site_id, ts, day) VALUES ('c', 4000, '2026-01-03')").run();
    db.exec(LAST_HIT_FILL_MIGRATION);
    assert.equal((db.prepare("SELECT last_hit FROM sites WHERE id = 'c'").get() as { last_hit: number | null }).last_hit, 4000, "remplissage des lignes NULL");
    assert.equal((db.prepare("SELECT last_hit FROM sites WHERE id = 'a'").get() as { last_hit: number | null }).last_hit, 3000, "valeur plus récente conservée");
    assert.ok((db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'events_site_ts'").get()), "index MAX(ts) par site");
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
