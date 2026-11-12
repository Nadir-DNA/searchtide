// Point 1 : fraîcheur sur la dernière donnée, états distincts, pause/module inactif sans alerte, alerte agrégée.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, localDay } from "./db.ts";
import { freshness } from "./freshness.ts";
import { saveIndicator, saveProject, record } from "./projects.ts";
import { today } from "./today.ts";

const at = (day: string) => Date.parse(`${day}T12:00:00Z`);

test("Point 1 : périmé ≠ erreur ≠ jamais reçu ; manuel sans seuil ignoré ; projet en pause ignoré", () => {
  const p = saveProject(null, { name: "Fraîcheur", sites: ["frais.test"] })!;
  db.prepare("INSERT INTO sites (id, domain, name, created_at, last_hit, gsc_property) VALUES ('fs', 'frais.test', 'frais', 0, ?, 'sc-domain:frais.test')").run(at("2026-11-07"));
  db.prepare("INSERT INTO gsc_syncs (site_id, synced_at, last_day) VALUES ('fs', 0, '2026-11-01')").run();
  const ind = saveIndicator(null, p.id, { label: "Ventes", mode: "daily", source: "manual", stale_after_days: 2 })!;
  record(ind.id, "2026-11-07", 5);
  const never = saveIndicator(null, p.id, { label: "Contacts", mode: "total", source: "manual", stale_after_days: 2 })!;
  const err = saveIndicator(null, p.id, { label: "MRR", mode: "total", source: "manual", stale_after_days: 2 })!;
  db.prepare("UPDATE indicators SET last_error = 'panne' WHERE id = ?").run(err.id);
  const off = saveIndicator(null, p.id, { label: "Sans seuil", mode: "daily", source: "manual" })!;
  record(off.id, "2026-01-01", 1);

  const now = at("2026-11-11");
  const items = freshness(now);
  const by = (id: string) => items.find((i) => i.key === `indicator:${id}`);
  assert.equal(by(ind.id)!.state, "stale", "4 jours > seuil 2");
  assert.equal(by(never.id)!.state, "never");
  assert.equal(by(err.id)!.state, "error");
  assert.equal(by(off.id), undefined, "manuel sans seuil : aucune alerte");
  assert.equal(items.find((i) => i.kind === "tracker")!.state, "stale");
  assert.equal(items.find((i) => i.kind === "gsc")!.state, "stale");

  saveProject(p.id, { paused: true });
  assert.equal(freshness(now).length, 0, "projet en pause : aucune alerte");
});

test("Point 1 : une seule alerte agrégée par projet et par jour dans Aujourd'hui", () => {
  const p = saveProject(null, { name: "Agrégat", sites: [] })!;
  const a = saveIndicator(null, p.id, { label: "A", mode: "daily", source: "manual", stale_after_days: 1 })!;
  const b = saveIndicator(null, p.id, { label: "B", mode: "daily", source: "manual", stale_after_days: 1 })!;
  record(a.id, "2026-01-01", 1); record(b.id, "2026-01-01", 1);
  const items = today(new Date("2026-11-11T12:00:00Z")).filter((i) => i.key.startsWith("sources:"));
  assert.equal(items.length, 1, "une alerte par projet");
  assert.equal(items[0].project_id, p.id);
  assert.match(items[0].text, /sources à vérifier/);
  assert.match(items[0].key, new RegExp(localDay(new Date("2026-11-11T12:00:00Z"))));
});
