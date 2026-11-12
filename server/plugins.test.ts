import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlugins } from "./modules/plugins.ts";
import { getModule } from "./modules/index.ts";

test("modules privés : un module valide est chargé, un module invalide est refusé sans arrêter le serveur", async () => {
  const dir = mkdtempSync(join(tmpdir(), "st-plugins-"));
  try {
    writeFileSync(join(dir, "ok.ts"), `export default { id: "prive-ok", name: "Privé", description: "Un module privé.", category: "produit", scope: "instance" };`);
    writeFileSync(join(dir, "ko.ts"), `export default { id: "prive-ko", name: "Cassé", description: "x", category: "inconnue", scope: "instance" };`);
    writeFileSync(join(dir, "notes.md"), "ignoré");
    const r = await loadPlugins(dir);
    assert.deepEqual(r.loaded, ["prive-ok"]);
    assert.equal(r.rejected.length, 1);
    assert.equal(r.rejected[0].file, "ko.ts");
    assert.match(r.rejected[0].errors.join(" "), /catégorie inconnue/);
    assert.ok(getModule("prive-ok") && !getModule("prive-ko"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("modules privés : sans PLUGINS_DIR, rien n'est chargé", async () => {
  delete process.env.PLUGINS_DIR;
  assert.deepEqual(await loadPlugins(), { loaded: [], rejected: [] });
});

test("modules privés : un fichier peut aussi déclarer ses connecteurs (export connectors)", async () => {
  const { get } = await import("./connectors/registry.ts");
  const dir = mkdtempSync(join(tmpdir(), "st-plugins-"));
  try {
    writeFileSync(join(dir, "base.ts"), `
      export const connectors = [{ id: "prive-base", name: "Base privée", provider: "La base", monogram: "BP", description: "x", category: "produit", minutes: 1,
        unlocks: ["Clients"], fields: [], guide: [], hint: () => "base", test: async () => ({ ok: true }) }];
      export default { id: "prive-base-mod", name: "Base", description: "Clients de la base privée.", category: "produit", scope: "projet", connectors: ["prive-base"] };`);
    const r = await loadPlugins(dir);
    assert.deepEqual(r.loaded, ["prive-base-mod"]);
    assert.ok(get("prive-base"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
