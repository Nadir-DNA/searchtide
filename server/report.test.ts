import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db.ts";
import { createContact, savePublication, updateContact } from "./business.ts";
import { dueNow, evo, lastWeek, reportHtml, weeklyReport } from "./report.ts";

test("semaine précédente, du lundi au dimanche", () => {
  assert.deepEqual(lastWeek(new Date("2026-11-09T07:00:00Z")), { from: "2026-11-02", to: "2026-11-08" }); // lundi
  assert.deepEqual(lastWeek(new Date("2026-11-15T20:00:00Z")), { from: "2026-11-02", to: "2026-11-08" }); // dimanche
});

test("évolutions lisibles", () => {
  assert.equal(evo(15, 10).text, "+50 %");
  assert.equal(evo(5, 0).text, "nouveau");
  assert.equal(evo(0, 0).text, "");
  assert.deepEqual(evo(8.5, 10, true), { text: "+1,5 place", tone: "up" });
});

test("envoi dû le lundi à partir de 8 h (heure de Paris), une fois par semaine", () => {
  assert.equal(dueNow(new Date("2026-11-09T06:30:00Z")), false); // 7 h 30 à Paris
  assert.equal(dueNow(new Date("2026-11-09T07:30:00Z")), true);  // 8 h 30
  assert.equal(dueNow(new Date("2026-11-10T07:30:00Z")), false); // mardi
  db.prepare("INSERT INTO settings (key, value) VALUES ('report_sent_week', '2026-11-02') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  assert.equal(dueNow(new Date("2026-11-09T07:30:00Z")), false, "déjà envoyé cette semaine");
});

test("rapport : sites, CRM et publications de la semaine, HTML échappé", () => {
  db.prepare("INSERT INTO sites (id, domain, name, created_at) VALUES ('r1', 'rapport.test', 'rapport.test', 0)").run();
  const ins = db.prepare("INSERT INTO events (site_id, ts, day, visitor, type, path, channel) VALUES ('r1', 0, ?, ?, 'pageview', '/', 'search')");
  ins.run("2026-11-03", "a"); ins.run("2026-11-04", "b"); ins.run("2026-10-28", "c");
  savePublication(null, { day: "2026-11-05", title: "<Vidéo>", status: "published" });
  savePublication(null, { day: "2026-11-11", title: "Post suivant" });
  const c = createContact({ name: "Client Test", value: 500 });
  updateContact(c.id, { stage: "won" });
  const r = weeklyReport({ from: "2026-11-02", to: "2026-11-08" });
  const s = r.sites.find((x) => x.domain === "rapport.test")!;
  assert.equal(s.visitors, 2); assert.equal(s.prevVisitors, 1);
  assert.equal(r.pubs.published.length, 1); assert.equal(r.pubs.next.length, 1);
  const html = reportHtml(r);
  assert.ok(html.includes("&lt;Vidéo&gt;") && !html.includes("<Vidéo>"));
  assert.ok(html.includes("+100 %"));
});
