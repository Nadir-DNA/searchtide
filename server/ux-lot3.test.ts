// Lot 3 : diagnostic réservé à l'administrateur.
import { test } from "node:test";
import assert from "node:assert/strict";
import { login, startServer, tempDb } from "./test-server.ts";

test("A8 : /api/diagnostic donne version, heure, fuseau, disque et tâches ; 403 pour une clé d'API", async () => {
  const t = tempDb();
  const s = await startServer(t.path);
  try {
    const d = await (await fetch(`${s.base}/api/diagnostic`, { headers: { Cookie: await login(s.base) } })).json();
    assert.equal(d.version, "0.3.0");
    assert.equal(typeof d.now, "number");
    assert.equal(d.tz, "Europe/Paris");
    assert.equal(typeof d.disk.free, "number");
    assert.ok(Array.isArray(d.jobs));
    const key = { Authorization: "Bearer cle-api-de-test-0001" };
    assert.equal((await fetch(`${s.base}/api/diagnostic`, { headers: key })).status, 403);
  } finally { s.stop(); t.done(); }
});
