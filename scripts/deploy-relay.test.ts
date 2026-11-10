// CA60 : `npm run deploy:relay` refuse un changement de mode non voulu et vérifie après déploiement.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deployRelay, fileMode } from "./deploy-relay.mjs";

const toml = (mode) => `name = "searchtide-connect"\n[vars]\nMODE = "${mode}"\n`;

function harness({ file = "live", before = "live", after = null, runStatus = 0 } = {}) {
  const calls = { run: 0, urls: [] };
  const fetchImpl = async (url) => {
    calls.urls.push(url);
    const mode = calls.urls.length === 1 ? before : (after ?? before);
    return { ok: mode !== null, json: async () => (mode === null ? { error: "x" } : { ok: true, mode }) };
  };
  const run = () => { calls.run++; return runStatus; };
  return { calls, fetchImpl, run, readFile: () => toml(file), log: () => {} };
}

test("CA60 : même mode → déploie et vérifie", async () => {
  const h = harness({ file: "live", before: "live", after: "live" });
  const r = await deployRelay({ url: "https://connect.test", fetchImpl: h.fetchImpl, run: h.run, readFile: h.readFile, log: h.log });
  assert.deepEqual(r, { before: "live", after: "live" });
  assert.equal(h.calls.run, 1);
});

test("CA60 : mode différent sans option → refuse sans déployer", async () => {
  const h = harness({ file: "live", before: "test" });
  await assert.rejects(() => deployRelay({ url: "https://connect.test", fetchImpl: h.fetchImpl, run: h.run, readFile: h.readFile, log: h.log }), /--changer-de-mode/);
  assert.equal(h.calls.run, 0);
});

test("CA60 : mode différent avec --changer-de-mode → déploie", async () => {
  const h = harness({ file: "live", before: "test", after: "live" });
  const r = await deployRelay({ url: "https://connect.test", fetchImpl: h.fetchImpl, run: h.run, readFile: h.readFile, log: h.log, changeMode: true });
  assert.deepEqual(r, { before: "test", after: "live" });
  assert.equal(h.calls.run, 1);
});

test("CA60 : le mode change après déploiement → échec explicite", async () => {
  const h = harness({ file: "live", before: "live", after: "test" });
  await assert.rejects(() => deployRelay({ url: "https://connect.test", fetchImpl: h.fetchImpl, run: h.run, readFile: h.readFile, log: h.log }), /le mode a changé/);
});

test("CA60 : wrangler en échec → erreur, pas de vérification finale", async () => {
  const h = harness({ file: "live", before: "live", runStatus: 2 });
  await assert.rejects(() => deployRelay({ url: "https://connect.test", fetchImpl: h.fetchImpl, run: h.run, readFile: h.readFile, log: h.log }), /wrangler deploy a échoué/);
});

test("CA60 : mode courant illisible → refuse par défaut", async () => {
  const h = harness({ file: "live", before: null });
  await assert.rejects(() => deployRelay({ url: "https://connect.test", fetchImpl: h.fetchImpl, run: h.run, readFile: h.readFile, log: h.log }), /illisible/);
  assert.equal(h.calls.run, 0);
});

test("CA60 : fileMode lit le mode du fichier", () => {
  assert.equal(fileMode(toml("test")), "test");
  assert.equal(fileMode("name = \"x\""), null);
});
