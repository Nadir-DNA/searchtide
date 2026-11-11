// B2 : le cache mémoire sert l'ancienne valeur moins de 30 s, puis expire ; une mutation passe par reload (réseau).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CACHE_MS, clearCache, readCache, writeCache } from "../web/src/cache.ts";

test("B2 : cache 30 s, expiration stricte et vidage explicite", () => {
  clearCache();
  writeCache("/api/x", { n: 1 }, 1_000);
  assert.deepEqual(readCache("/api/x", 1_000 + CACHE_MS - 1), { n: 1 });
  assert.equal(readCache("/api/x", 1_000 + CACHE_MS), null, "expiré à 30 s");
  clearCache();
  assert.equal(readCache("/api/x", 1_001), null);
});
