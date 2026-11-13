import { test } from "node:test";
import assert from "node:assert/strict";
import { allModules, checkModule, getModule, registerModule } from "./modules/index.ts";
import { widgetDefs } from "./dashboards.ts";

test("modules : les 13 modules sont déclarés, dont 4 cœur", () => {
  assert.equal(allModules().length, 13);
  assert.deepEqual(allModules().filter((m) => m.core).map((m) => m.id).sort(), ["agents", "analytics", "pages", "projets"]);
});

test("modules : chaque bloc de WIDGETS appartient à exactement un module", () => {
  for (const w of Object.keys(widgetDefs())) assert.equal(allModules().filter((m) => m.widgets?.[w]).length, 1, w);
});

test("modules : un connecteur inconnu ou un id déjà pris est refusé", () => {
  assert.throws(() => registerModule({ ...getModule("stripe")!, id: "x-test", connectors: ["inexistant"] }), /inexistant/);
  assert.throws(() => registerModule(getModule("stripe")!), /déjà/);
});

test("modules : checkModule ne trouve aucun défaut dans les modules livrés", () => {
  for (const m of allModules()) assert.deepEqual(checkModule(m), [], m.id);
});
