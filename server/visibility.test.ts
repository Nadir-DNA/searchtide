// B5 : visibilité dans les IA — citation et place, une question par IA et par semaine, tendance, alerte de recul.
import { test } from "node:test";
import assert from "node:assert/strict";
process.env.SECRET ??= "secret-de-test-".repeat(4);
import { db } from "./db.ts";
import { createConnection } from "./connections.ts";
import "./connectors/index.ts";
import { addPrompt, analyzeAnswer, isoWeek, runVisibility, setBrand, visibilityReport } from "./visibility.ts";
import { today } from "./today.ts";

const P = "proj-visi";
db.prepare("INSERT INTO projects (id, name, crm_key, sites, created_at) VALUES (?, ?, ?, ?, 0)").run(P, "Atelier Lumen", "lumen", JSON.stringify(["atelier-lumen.fr"]), );

test("semaine ISO", () => {
  assert.equal(isoWeek(new Date("2026-11-16T10:00:00Z")), "2026-W47");
  assert.equal(isoWeek(new Date("2027-01-01T10:00:00Z")), "2026-W53");
});

test("analyse : citée (sans accents ni casse), place parmi les marques nommées, domaines tiers relevés", () => {
  const a = analyzeAnswer("Je recommande d'abord Lumina Studio, puis l'ATELIER LUMEN (atelier-lumen.fr), ou voyez aussi deco-pro.fr.", ["Atelier Lumen", "atelier-lumen.fr"], ["Lumina Studio"]);
  assert.deepEqual(a, { cited: true, rank: 2, competitors: ["Lumina Studio", "deco-pro.fr"] });
  assert.deepEqual(analyzeAnswer("Essayez Lumina Studio.", ["Atelier Lumen"], ["Lumina Studio"]), { cited: false, rank: null, competitors: ["Lumina Studio"] });
  assert.equal(analyzeAnswer("Un lumen est une unité.", ["Atelier Lumen"], []).cited, false, "un mot isolé du nom ne compte pas");
});

test("une question par IA et par semaine ; erreurs gardées ; tendance et alerte de recul", async () => {
  db.prepare("DELETE FROM connections WHERE kind = 'ai'").run();
  assert.deepEqual(await runVisibility({ project: P }), { asked: 0, reason: "Aucune IA connectée" });
  createConnection({ kind: "ai", label: "Claude", config: { provider: "anthropic" }, secrets: { api_key: "sk-ant-0123456789" } } as any);
  createConnection({ kind: "ai", label: "GPT", config: { provider: "openai", model: "gpt-test" }, secrets: { api_key: "sk-0123456789" } } as any);
  setBrand(P, { names: "Lumen", competitors: "Lumina Studio, Clair & Co" });
  addPrompt(P, "Quel atelier choisir pour un luminaire sur mesure ?");
  addPrompt(P, "Qui fabrique des lampes artisanales en France ?");
  assert.throws(() => addPrompt(P, "court"), /8 caractères/);

  let calls = 0;
  const w1 = new Date("2026-11-09T10:00:00Z"), w2 = new Date("2026-11-16T10:00:00Z");
  const r1 = await runVisibility({ project: P, now: w1, ask: async (c) => { calls++; if (c.provider === "openai" && calls === 4) throw new Error("quota"); return "Atelier Lumen est une bonne adresse, comme Lumina Studio."; } });
  assert.equal(r1.asked, 4);
  assert.equal((await runVisibility({ project: P, now: w1, ask: async () => { throw new Error("ne doit pas être rappelé"); } })).asked, 0, "déjà posé cette semaine");
  await runVisibility({ project: P, now: w2, ask: async (c) => c.provider === "anthropic" ? "Lumina Studio, sans hésiter." : "Lumen, puis Clair & Co." });

  const rep = visibilityReport(P);
  assert.deepEqual(rep.weeks, ["2026-W46", "2026-W47"]);
  const claude = rep.models.find((m) => m.provider === "anthropic")!, gpt = rep.models.find((m) => m.provider === "openai")!;
  assert.deepEqual(claude.series.map((s) => s.share), [100, 0]);
  assert.deepEqual(gpt.series.map((s) => [s.share, s.answers]), [[100, 1], [100, 2]], "la réponse en erreur ne compte pas");
  assert.equal(rep.prompts[0].answers.length, 2);
  assert.ok(rep.rivals.some((r) => r.name === "Lumina Studio"));
  assert.ok(today().some((i) => i.key.startsWith("visibilite-ia:proj-visi:anthropic") && /100 % → 0 %/.test(i.text)));
});
