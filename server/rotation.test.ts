// Tests T7 (CA9) : changer SECRET ne casse rien ; les connexions passent en « à reconnecter » et les relevés échouent proprement.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db.ts";
import { createConnection, connections, getSecrets, sweepVault, startVault } from "./connections.ts";
import { collect, collectAll, saveIndicator, saveProject } from "./projects.ts";
import { RECONNECT_MESSAGE, SECRET_MESSAGE, VaultError } from "./vault.ts";

const A = "a".repeat(40), B = "b".repeat(40);
const useSecret = (v?: string) => { if (v === undefined) delete process.env.SECRET; else process.env.SECRET = v; };

test("CA9 : SECRET changé → « à reconnecter », relevés en échec propre, sans exception non gérée", async () => {
  useSecret(A);
  const conn = createConnection({ kind: "stripe", label: "Compte test", secrets: { key: "rk_" + "test_ROTATION0001" }, fingerprintOf: "rk_" + "test_ROTATION0001" });
  const p = saveProject(null, { name: "Rotation" })!;
  const ind = saveIndicator(null, p.id, { label: "MRR", mode: "total", source: "stripe", config: { metric: "mrr", connection_id: conn.id } })!;
  assert.equal(sweepVault().reconnect, 0);
  assert.equal(connections().find((c) => c.id === conn.id)!.status, "connected");

  useSecret(B); // l'administrateur a changé SECRET
  const sw = sweepVault();
  assert.ok(sw.reconnect >= 1);
  const after = connections().find((c) => c.id === conn.id)!;
  assert.equal(after.status, "reconnect");
  assert.equal(after.status_detail, RECONNECT_MESSAGE);

  // Le relevé échoue avec le message attendu, enregistré sur l'indicateur ; aucune clé n'est lue, aucune requête réseau
  const real = globalThis.fetch; let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response("{}"); }) as typeof fetch;
  try {
    await assert.rejects(collect(ind), (e: any) => e instanceof VaultError && e.message === RECONNECT_MESSAGE);
    assert.equal(calls, 0);
    assert.equal((db.prepare("SELECT last_error FROM indicators WHERE id = ?").get(ind.id) as any).last_error, RECONNECT_MESSAGE);
    await collectAll(); // la boucle de relevé attrape l'erreur au lieu de la propager
  } finally { globalThis.fetch = real; }
  assert.throws(() => getSecrets(conn.id), (e: any) => e.code === "undecryptable");

  useSecret(A); // retour à l'ancien SECRET : les connexions redeviennent lisibles
  sweepVault();
  assert.equal(connections().find((c) => c.id === conn.id)!.status, "connected");
  assert.equal(getSecrets(conn.id).key, "rk_" + "test_ROTATION0001");
});

test("SECRET retiré ou invalide : « à reconnecter » avec le message R2, démarrage sans exception", () => {
  useSecret(A);
  const conn = createConnection({ kind: "ntfy", label: "ntfy rotation", secrets: { topic: "sujet-rotation-0001" } });
  useSecret("dev-secret");
  assert.doesNotThrow(() => startVault());
  const c = connections().find((x) => x.id === conn.id)!;
  assert.equal(c.status, "reconnect");
  assert.equal(c.status_detail, SECRET_MESSAGE);
  useSecret(A);
  sweepVault();
  assert.equal(connections().find((x) => x.id === conn.id)!.status, "connected");
});
