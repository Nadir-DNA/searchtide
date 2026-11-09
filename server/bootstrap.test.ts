// T24 : valeurs de démarrage. Une variable d'environnement gagne ; sinon la valeur est générée puis relue
// au redémarrage, pour qu'un conteneur neuf démarre sans fichier à éditer et que le coffre survive au redémarrage.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootFiles, bootValue } from "./bootstrap.ts";

const dir = () => mkdtempSync(join(tmpdir(), "st-boot-"));

test("l'environnement est prioritaire et n'écrit aucun fichier", () => {
  const d = dir(); try {
    const f = join(d, "secret");
    const v = bootValue("depuis-l-environnement", f, 32, "hex");
    assert.deepEqual(v, { value: "depuis-l-environnement", created: false, file: f });
    assert.throws(() => statSync(f), "aucun fichier créé");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("SECRET généré : 64 caractères hexadécimaux, écrit en 600, relu tel quel au redémarrage", () => {
  const d = dir(); try {
    const f = join(d, "sous-dossier", "secret");
    const a = bootValue(undefined, f, 32, "hex");
    assert.equal(a.created, true);
    assert.match(a.value, /^[0-9a-f]{64}$/);
    assert.equal(readFileSync(f, "utf8").trim(), a.value);
    assert.equal(statSync(f).mode & 0o777, 0o600);
    const b = bootValue(undefined, f, 32, "hex");
    assert.deepEqual(b, { value: a.value, created: false, file: f }, "même secret au redémarrage");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("mot de passe généré : 16 caractères utilisables sans échappement, relu tel quel", () => {
  const d = dir(); try {
    const f = join(d, "admin-password");
    const a = bootValue(undefined, f, 12, "password");
    assert.equal(a.created, true);
    assert.match(a.value, /^[A-Za-z0-9_-]{16}$/);
    const b = bootValue(undefined, f, 12, "password");
    assert.equal(b.value, a.value);
    assert.equal(b.created, false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("valeur vide dans l'environnement = absente ; fichier vide = régénéré", () => {
  const d = dir(); try {
    const f = join(d, "secret");
    const a = bootValue("   ", f, 32, "hex");
    assert.equal(a.created, true);
    assert.equal(readFileSync(f, "utf8") && a.value.length, 64);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("fichiers de démarrage rangés à côté de la base (volume /data en Docker)", () => {
  assert.deepEqual(bootFiles("/data/searchtide.db"), { secret: "/data/secret", password: "/data/admin-password" });
  assert.deepEqual(bootFiles("data/searchtide.db"), { secret: "data/secret", password: "data/admin-password" });
  assert.deepEqual(bootFiles(":memory:"), { secret: "data/secret", password: "data/admin-password" });
});
