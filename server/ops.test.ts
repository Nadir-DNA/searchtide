import { test } from "node:test";
import assert from "node:assert/strict";
import { record, saveIndicator, saveProject } from "./projects.ts";
import { checkAlerts } from "./ops.ts";
import { createContact } from "./business.ts";

test("alertes : baisse de plus de 30 %, relances du jour, une seule fois", async () => {
  const p = saveProject(null, { name: "Alerte test" })!;
  const ind = saveIndicator(null, p.id, { label: "Inscriptions", mode: "daily", source: "manual" })!;
  const now = new Date("2026-11-09T09:00:00Z");
  for (let d = 3; d <= 9; d++) record(ind.id, `2026-11-0${d}`, 1);           // 7 cette semaine
  for (let d = 27; d <= 31; d++) record(ind.id, `2026-10-${d}`, 4);          // 20 la semaine d'avant
  record(ind.id, "2026-11-01", 0); record(ind.id, "2026-11-02", 0);
  createContact({ name: "À rappeler", next_at: "2026-11-01" });
  const fired = await checkAlerts(now);
  assert.ok(fired.includes("baisse Inscriptions"), fired.join(", "));
  assert.ok(fired.includes("relances"));
  assert.deepEqual(await checkAlerts(now), [], "pas de doublon");
});
