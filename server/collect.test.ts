import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db.ts";
import { channelOf, collect, parseUA, refusals } from "./collect.ts";
import { strikingDistance, trafficStats } from "./stats.ts";

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";
db.prepare("INSERT INTO sites (id, domain, name, gsc_property, created_at) VALUES ('s1', 'exemple.com', 'Exemple', NULL, 0)").run();
db.prepare("INSERT INTO sites (id, domain, name, gsc_property, created_at) VALUES ('s2', 'last-hit.test', 'Last hit', NULL, 0)").run();
db.prepare("INSERT INTO sites (id, domain, name, gsc_property, created_at) VALUES ('s3', 'limite.test', 'Limite', NULL, 0)").run();

test("canaux", () => {
  assert.equal(channelOf(null, null), "direct");
  assert.equal(channelOf("google.com", null), "search");
  assert.equal(channelOf("gemini.google.com", null), "ai");
  assert.equal(channelOf("chatgpt.com", null), "ai");
  assert.equal(channelOf("t.co", null), "social");
  assert.equal(channelOf("blog.ami.fr", "cpc"), "paid");
  assert.equal(channelOf("blog.ami.fr", null), "referral");
});

test("user-agent", () => {
  assert.deepEqual(parseUA(UA), { browser: "Safari", os: "iOS", device: "mobile" });
});

test("collecte et statistiques", () => {
  const t = Date.parse("2026-11-01T10:00:00Z");
  assert.equal(collect({ site: "exemple.com", url: "https://www.exemple.com/a?utm_campaign=lancement", referrer: "https://chatgpt.com/" }, "1.1.1.1", UA, "MA", t), true);
  assert.equal(collect({ site: "exemple.com", url: "https://exemple.com/b", referrer: "https://exemple.com/a" }, "1.1.1.1", UA, "MA", t + 1000), true);
  // 1.1 : last_hit écrit à la première visite, pas réécrit dans les 30 s suivantes (site dédié)
  const lastHit = () => (db.prepare("SELECT last_hit FROM sites WHERE id = 's2'").get() as { last_hit: number | null }).last_hit;
  assert.equal(collect({ site: "last-hit.test", url: "https://last-hit.test/a" }, "1.1.1.1", UA, null, t), true);
  assert.equal(lastHit(), t);
  assert.equal(collect({ site: "last-hit.test", url: "https://last-hit.test/b" }, "1.1.1.1", UA, null, t + 1000), true);
  assert.equal(lastHit(), t, "pas de réécriture dans les 30 s");
  assert.equal(collect({ site: "last-hit.test", url: "https://last-hit.test/c" }, "1.1.1.1", UA, null, t + 31_000), true);
  assert.equal(lastHit(), t + 31_000);
  assert.equal(collect({ site: "exemple.com", url: "https://autre.com/" }, "2.2.2.2", UA, null, t), false, "domaine étranger refusé");
  assert.equal(collect({ site: "exemple.com", url: "https://exemple.com/" }, "3.3.3.3", "Googlebot/2.1", null, t), false, "robot ignoré");
  assert.equal(collect({ site: "inconnu.com", url: "https://inconnu.com/" }, "3.3.3.3", UA, null, t), false);
  // D3 : les refus sont comptés par raison, sans IP ni user-agent
  assert.equal(refusals("s1", "exemple.com")["hôte différent"], 1);
  assert.equal(refusals("s1", "exemple.com")["robot ou outil"], 1);
  assert.equal(refusals("s1", "exemple.com")["domaine inconnu"] ?? 0, 0);
  assert.deepEqual(Object.keys(refusals("s1", "exemple.com")).sort(), ["hôte différent", "robot ou outil"]);
  assert.equal(refusals("inconnu.com", "inconnu.com")["domaine inconnu"], 1);

  const s = trafficStats("s1", { from: "2026-11-01", to: "2026-11-01" });
  assert.deepEqual(s.totals, { visitors: 1, pageviews: 2, ai: 1 });
  assert.deepEqual(s.previous, { visitors: 0, pageviews: 0, ai: 0 });
  assert.equal(s.aiReferrers[0].key, "chatgpt.com");
  assert.equal(s.campaigns[0].key, "lancement");
  assert.equal(s.channels.find((c) => c.key === "direct")?.pageviews, 1, "navigation interne = direct");
});

test("F3 : limite par site et par IP, réponse inchangée, refus comptés", () => {
  const now = Date.parse("2026-11-02T10:00:00Z");
  let accepted = 0;
  for (let i = 0; i < 130; i++) if (collect({ site: "limite.test", url: "https://limite.test/p" }, "9.9.9.9", UA, null, now)) accepted++;
  assert.ok(accepted < 130, "le burst est limité");
  assert.ok(accepted >= 100, "le seuil reste généreux");
  assert.ok((refusals("s3", "limite.test")["trop de visites"] ?? 0) >= 1);
});

test("opportunités Search Console", () => {
  const ins = db.prepare("INSERT INTO gsc_rows VALUES ('s1', ?, ?, ?, ?, ?, ?)");
  ins.run("2026-11-01", "salon casablanca", "/a", 3, 400, 8.4);
  ins.run("2026-11-01", "salon casablanca", "/b", 0, 100, 14.4); // cannibalisation : moyenne pondérée = 9.6
  ins.run("2026-11-01", "marque", "/", 50, 60, 1.1);
  const o = strikingDistance("s1", { from: "2026-11-01", to: "2026-11-01" });
  assert.deepEqual(o.map((r) => [r.query, r.position, r.impressions]), [["salon casablanca", 9.6, 500]]);
});

test("totaux Search Console complets malgré les requêtes masquées", async () => {
  const { searchStats } = await import("./stats.ts");
  const ins = db.prepare("INSERT INTO gsc_rows VALUES ('s1', ?, ?, ?, ?, ?, ?)");
  ins.run("2026-11-02", "", "", 1, 6, 5); // totaux du jour (requêtes rares incluses)
  ins.run("2026-11-02", "", "/a", 1, 6, 5); // par page
  ins.run("2026-11-02", "visible", "/a", 0, 2, 7); // seule requête non masquée
  const s = searchStats("s1", { from: "2026-11-02", to: "2026-11-02" });
  assert.equal(s.totals.impressions, 6);
  assert.deepEqual(s.pages.map((p) => [p.page, p.impressions]), [["/a", 6]]);
  assert.deepEqual(s.queries.map((q) => q.query), ["visible"]);
});

test("période précédente", async () => {
  const { previous } = await import("./stats.ts");
  assert.deepEqual(previous({ from: "2026-11-01", to: "2026-11-28" }), { from: "2026-10-04", to: "2026-10-31" });
});

test("jour civil à l'heure de Paris", async () => {
  const { localDay } = await import("./db.ts");
  assert.equal(localDay(Date.parse("2026-11-08T23:30:00Z")), "2026-11-09"); // 0 h 30 à Paris
  assert.equal(localDay(Date.parse("2026-07-01T21:59:00Z")), "2026-07-01"); // 23 h 59 en été
});
