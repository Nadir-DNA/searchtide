import { test } from "node:test";
import assert from "node:assert/strict";
import { compareSnapshots, isCopyPath } from "./verifier-migration.mjs";

const snap = (over: Record<string, unknown> = {}) => ({
  totals: { visitors: 10, revenue: 0, clicks: 4, leads: 0 },
  projects: { p1: { name: "A", sites: ["a.fr"], indicators: [{ id: "i1", label: "MRR", value: 120, previous: 100 }] } },
  dashboards: [{ name: "Vue d'ensemble", widgets: ["pulse", "todo"] }],
  ...over,
});

test("vérification : un 0 devenu null (source absente) est accepté, tout autre écart est signalé", () => {
  assert.deepEqual(compareSnapshots(snap(), snap({ totals: { visitors: 10, revenue: null, clicks: 4, leads: null } })), []);
  const diffs = compareSnapshots(snap(), snap({ totals: { visitors: 9, revenue: 0, clicks: null, leads: 0 } }));
  assert.deepEqual(diffs, ["totals.visitors : 10 → 9", "totals.clicks : 4 → null"]);
});

test("vérification : un indicateur disparu ou une page modifiée est signalé", () => {
  const after = snap({ projects: { p1: { name: "A", sites: ["a.fr"], indicators: [] } }, dashboards: [{ name: "Vue d'ensemble", widgets: ["pulse"] }] });
  const d = compareSnapshots(snap(), after);
  assert.ok(d.some((x) => x.startsWith("projects.p1.indicators.0")));
  assert.ok(d.some((x) => x.startsWith("dashboards.0.widgets.1")));
});

test("vérification : refuse la base de production du conteneur", () => {
  assert.equal(isCopyPath("/data/searchtide.db"), false);
  assert.equal(isCopyPath("/tmp/copie-instance.db"), true);
  assert.equal(isCopyPath("/tmp/copie.txt"), false);
});

test("vérification : un projet créé pour un site orphelin (spec §8) est accepté, pas un autre projet nouveau", () => {
  const before = snap();
  const orphan = snap({ projects: { ...before.projects, p2: { name: "seul.fr", sites: ["seul.fr"], indicators: [] } } });
  assert.deepEqual(compareSnapshots(before, orphan), []);
  const other = snap({ projects: { ...before.projects, p3: { name: "Inconnu", sites: [], indicators: [] } } });
  assert.equal(compareSnapshots(before, other).length, 1);
});
