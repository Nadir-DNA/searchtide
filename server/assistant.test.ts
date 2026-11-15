// B2 : assistant — boucle d'outils avec Claude (SDK) et avec une API compatible OpenAI, lecture seule, erreurs lisibles.
import { test } from "node:test";
import assert from "node:assert/strict";
process.env.SECRET ??= "secret-de-test-".repeat(4);
import { db } from "./db.ts";
import { createConnection } from "./connections.ts";
import "./connectors/index.ts";
import { ask } from "./assistant.ts";
import { readOnlyCatalog, type CatalogTool } from "./mcp.ts";

const tools: CatalogTool[] = [{ name: "portfolio_overview", description: "vue d'ensemble", schema: { type: "object", properties: { days: { type: "number" } } },
  run: async (a) => JSON.stringify({ projets: [{ nom: "Atelier", clics: 120, jours: a.days ?? 28 }] }) }];
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

test("Claude : appel d'outil, résultat renvoyé, réponse finale ; outils consultés listés", async () => {
  db.prepare("DELETE FROM connections WHERE kind = 'ai'").run();
  createConnection({ kind: "ai", label: "Claude", config: { provider: "anthropic" }, secrets: { api_key: "sk-ant-test-0123456789" } } as any);
  const bodies: any[] = [];
  const f = (async (u: any, i: any) => {
    assert.match(String(u), /api\.anthropic\.com\/v1\/messages/);
    const b = JSON.parse(String(i.body)); bodies.push(b);
    if (bodies.length === 1) return json({ id: "m1", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: "tool_use", id: "tu1", name: "portfolio_overview", input: { days: 7 } }] });
    return json({ id: "m2", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: "text", text: "Atelier : 120 clics sur 7 jours (Search Console)." }] });
  }) as typeof fetch;
  const r = await ask({ messages: [{ role: "user", content: "Comment vont mes projets ?" }] }, { fetch: f, tools, today: "2026-11-16" });
  assert.equal(r.answer, "Atelier : 120 clics sur 7 jours (Search Console).");
  assert.deepEqual(r.used, [{ name: "portfolio_overview", args: { days: 7 } }]);
  assert.equal(bodies[0].model, "claude-opus-5-5");
  assert.equal(bodies[0].fallbacks, "default");
  assert.equal(bodies[0].tools[0].name, "portfolio_overview");
  assert.match(bodies[0].system, /n'invente jamais un chiffre/);
  const result = bodies[1].messages.at(-1).content[0];
  assert.equal(result.type, "tool_result"); assert.equal(result.tool_use_id, "tu1"); assert.match(result.content, /"clics": ?120/);
});

test("API compatible OpenAI (Ollama) : fonctions, rôle tool, outil inconnu signalé sans planter", async () => {
  db.prepare("DELETE FROM connections WHERE kind = 'ai'").run();
  createConnection({ kind: "ai", label: "Local", config: { provider: "ollama", model: "llama3.1", base_url: "http://127.0.0.1:11434" }, secrets: {} } as any);
  const bodies: any[] = [];
  const f = (async (u: any, i: any) => {
    assert.equal(String(u), "http://127.0.0.1:11434/v1/chat/completions");
    assert.equal(i.headers.Authorization, undefined);
    bodies.push(JSON.parse(String(i.body)));
    if (bodies.length === 1) return json({ choices: [{ message: { content: null, tool_calls: [
      { id: "c1", type: "function", function: { name: "portfolio_overview", arguments: "{\"days\":28}" } },
      { id: "c2", type: "function", function: { name: "crm_save_contact", arguments: "{}" } }] } }] });
    return json({ choices: [{ message: { content: "Tout va bien." } }] });
  }) as typeof fetch;
  const r = await ask({ messages: [{ role: "user", content: "Bilan ?" }] }, { fetch: f, tools });
  assert.equal(r.answer, "Tout va bien.");
  assert.equal(r.used[1].error, "outil inconnu", "un outil d'écriture n'existe pas pour l'assistant");
  const tail = bodies[1].messages.slice(-2);
  assert.deepEqual(tail.map((m: any) => [m.role, m.tool_call_id]), [["tool", "c1"], ["tool", "c2"]]);
});

test("sans IA connectée : message qui dit quoi faire ; le catalogue ne contient aucun outil d'écriture", async () => {
  db.prepare("DELETE FROM connections WHERE kind = 'ai'").run();
  await assert.rejects(ask({ messages: [{ role: "user", content: "?" }] }), /Aucune IA connectée/);
  const names = readOnlyCatalog().map((t) => t.name);
  assert.ok(names.includes("portfolio_overview"), names.join(","));
  for (const w of ["crm_save_contact", "pubs_save", "keyword_track", "cms_draft", "indexing_submit", "pub_rule_propose", "seo_audit_run"]) assert.ok(!names.includes(w), w);
});
