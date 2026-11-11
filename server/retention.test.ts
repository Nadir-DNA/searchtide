// C9 : purge sûre, un site par appel, garde-fous et fixtures :memory: uniquement.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, localDay } from "./db.ts";
import { countEventsBefore, purgeEventsBefore } from "./retention.ts";
import { startServer, tempDb } from "./test-server.ts";

const shift = (day: string, days: number) => new Date(Date.parse(day + "T00:00:00Z") + days * 86_400_000).toISOString().slice(0, 10);

test("C9 : comptage strict, purge d'un seul site, autres tables intactes, date récente et expect périmé refusés", () => {
  if (process.env.DATABASE_PATH !== ":memory:") throw new Error("C9 : tests sur fixtures :memory: uniquement");
  db.prepare("INSERT INTO sites (id, domain, name, created_at) VALUES ('p1', 'purge.test', 'P', 0), ('p2', 'autre.test', 'A', 0)").run();
  const ins = db.prepare("INSERT INTO events (site_id, ts, day, visitor, type, path, channel) VALUES (?, 0, ?, ?, 'pageview', '/', 'direct')");
  for (let d = 1; d <= 10; d++) {
    const day = `2026-01-${String(d).padStart(2, "0")}`;
    ins.run("p1", day, `v${d}`);
    ins.run("p2", day, `v${d}`);
  }
  db.prepare("INSERT INTO gsc_rows VALUES ('p1', '2026-01-01', 'q', '/a', 1, 2, 3)").run();

  assert.equal(countEventsBefore({ siteId: "p1", before: "2026-01-06" }), 5, "strictement avant le 6");
  assert.equal(purgeEventsBefore({ siteId: "p1", before: "2026-01-06", expect: 5, dryRun: true }).deleted, 0, "dryRun ne supprime rien");
  assert.equal(countEventsBefore({ siteId: "p1", before: "2026-01-11" }), 10);
  assert.equal(purgeEventsBefore({ siteId: "p1", before: "2026-01-06", expect: 5 }).deleted, 5);
  assert.equal(countEventsBefore({ siteId: "p1", before: "2026-01-11" }), 5, "les 5 plus récents restent");
  assert.equal(countEventsBefore({ siteId: "p2", before: "2026-01-11" }), 10, "autre site intact");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM gsc_rows").get() as { n: number }).n, 1, "gsc_rows intact");
  assert.throws(() => purgeEventsBefore({ siteId: "p1", before: shift(localDay(), -10), expect: 0 }), /au moins 30 jours/, "date récente refusée");
  assert.throws(() => purgeEventsBefore({ siteId: "p1", before: "2026-01-11", expect: 3 }), (e: Error & { status?: number }) => e.status === 409, "expect périmé : 409, rien supprimé");
  assert.equal(countEventsBefore({ siteId: "p1", before: "2026-01-11" }), 5);
});

test("C9 : l'API réserve la purge à l'administrateur (403 clé d'API, lecture seule, clé d'agent)", async () => {
  const t = tempDb();
  const s = await startServer(t.path, { API_KEY_READ: "cle-lecture-test-0001" });
  try {
    const site = await (await fetch(`${s.base}/api/sites`, { method: "POST", headers: { Cookie: await (await import("./test-server.ts")).login(s.base), "content-type": "application/json" }, body: JSON.stringify({ domain: "purge-api.test" }) })).json();
    const key = { Authorization: "Bearer cle-api-de-test-0001", "content-type": "application/json" };
    const cookie = await (await import("./test-server.ts")).login(s.base);
    const agent = await (await fetch(`${s.base}/api/agents`, { method: "POST", headers: { Cookie: cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "purge-test", all_projects: true }) })).json();
    for (const auth of [key.Authorization, "Bearer cle-lecture-test-0001", `Bearer ${agent.key}`]) {
      const headers = { Authorization: auth, "content-type": "application/json" };
      assert.equal((await fetch(`${s.base}/api/sites/${site.id}/events/count?before=2026-01-01`, { headers })).status, 403, `comptage refusé (${auth.slice(0, 12)})`);
      assert.equal((await fetch(`${s.base}/api/sites/${site.id}/purge`, { method: "POST", headers, body: JSON.stringify({ before: "2026-01-01", expect: 0 }) })).status, 403, `purge refusée (${auth.slice(0, 12)})`);
    }
  } finally { s.stop(); t.done(); }
});
