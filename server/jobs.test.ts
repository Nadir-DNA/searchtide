import { test } from "node:test";
import assert from "node:assert/strict";
import { isDue, jobsStatus, parseEvery, registerJob, tick } from "./jobs.ts";
import { setEnabled } from "./modules/state.ts";
import { portfolio } from "./portfolio.ts";
import "./business.ts";

test("jobs : formats de période", () => {
  assert.deepEqual(parseEvery("6h"), { kind: "interval", ms: 21600000 });
  assert.deepEqual(parseEvery("30m"), { kind: "interval", ms: 1800000 });
  assert.deepEqual(parseEvery("daily@02:30"), { kind: "daily", hourUtc: 2, minute: 30 });
  assert.throws(() => parseEvery("toutes les heures"));
  assert.throws(() => parseEvery("daily@25:00"));
});

test("jobs : échéances", () => {
  const t = Date.parse("2026-11-10T03:00:00Z");
  assert.equal(isDue("6h", null, t), true);
  assert.equal(isDue("6h", t - 3600_000, t), false);
  assert.equal(isDue("6h", t - 6 * 3600_000, t), true);
  assert.equal(isDue("daily@02:30", Date.parse("2026-11-09T02:31:00Z"), t), true);
  assert.equal(isDue("daily@02:30", Date.parse("2026-11-10T02:31:00Z"), t), false);
  assert.equal(isDue("daily@02:30", null, Date.parse("2026-11-10T01:00:00Z")), false); // pas avant l'heure
});

test("jobs : une tâche d'un module inactif ne tourne pas", async () => {
  let runs = 0;
  registerJob("prospection", { id: "test-sequences", every: "30m", run: async () => { runs++; } });
  setEnabled("prospection", false);
  await tick(Date.now());
  assert.equal(runs, 0);
  setEnabled("prospection", true);
  await tick(Date.now());
  assert.equal(runs, 1);
  assert.equal(jobsStatus().find((j) => j.id === "test-sequences")!.ok, 1);
});

test("jobs : trois échecs consécutifs créent une alerte, un succès remet à zéro", async () => {
  let fail = true;
  registerJob("projets", { id: "test-panne", every: "30m", run: async () => { if (fail) throw new Error("base injoignable"); } });
  let t = Date.now();
  for (let i = 0; i < 3; i++) { await tick(t); t += 31 * 60_000; }
  const j = jobsStatus().find((x) => x.id === "test-panne")!;
  assert.deepEqual([j.fails, j.ok, j.error], [3, 0, "base injoignable"]);
  assert.ok(portfolio({ from: "2026-11-08", to: "2026-11-09" }).alerts.some((a) => a.text === "Tâche « test-panne » en échec 3 fois de suite : base injoignable"));
  fail = false; await tick(t);
  assert.equal(jobsStatus().find((x) => x.id === "test-panne")!.fails, 0);
});

test("jobs : sans BACKUP_URL, la sauvegarde externe ne compte pas comme un échec", async () => {
  const { Hono } = await import("hono");
  const { registerOps } = await import("./ops.ts");
  delete process.env.BACKUP_URL; delete process.env.BACKUP_TOKEN;
  registerOps(new Hono());
  let t = Date.parse("2026-11-10T03:00:00Z");
  for (let i = 0; i < 3; i++) { await tick(t); t += 86400000; }
  assert.equal(jobsStatus().find((j) => j.id === "offsite-backup")!.fails, 0);
});

test("jobs : la tâche en échec d'un module désactivé n'alerte plus", async () => {
  const { jobAlerts } = await import("./jobs.ts");
  setEnabled("prospection", true);
  registerJob("prospection", { id: "test-panne-module", every: "30m", run: async () => { throw new Error("smtp"); } });
  let t = Date.now() + 10 * 86400000;
  for (let i = 0; i < 3; i++) { await tick(t); t += 31 * 60_000; }
  assert.ok(jobAlerts().some((a) => a.text.includes("test-panne-module")));
  setEnabled("prospection", false);
  assert.ok(!jobAlerts().some((a) => a.text.includes("test-panne-module")));
});
