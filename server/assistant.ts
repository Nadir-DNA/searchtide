// Assistant intégré (plan B2) : questions en langage naturel sur vos données, avec l'IA de votre choix (connecteur IA).
// Il lit avec les mêmes outils que les agents MCP, en lecture seule : aucune publication, aucune correction, aucun envoi.
// Chaque réponse garde la liste des outils consultés, pour que l'utilisateur voie d'où viennent les chiffres.
import type { Hono } from "hono";
import Anthropic from "@anthropic-ai/sdk";
import { isAdmin } from "./admin.ts";
import { connections, getSecrets } from "./connections.ts";
import { realCtx } from "./connectors/registry.ts";
import { AI_PROVIDERS, aiBase, aiModel, aiProvider, anthropicClient } from "./connectors/ai.ts";
import type { Cfg } from "./connectors/types.ts";
import { readOnlyCatalog, type CatalogTool } from "./mcp.ts";

type Row = Record<string, any>;
export type ChatTurn = { role: "user" | "assistant"; content: string };
export type Used = { name: string; args: Record<string, unknown>; error?: string };
export type AiConn = { id: string; label: string; provider: string; model: string; cfg: Cfg };

const MAX_STEPS = 8;
const MAX_RESULT = 24_000;

/** Connexions IA utilisables, la première d'abord (ou celle demandée). */
export function aiConnections(): AiConn[] {
  return connections("ai").flatMap((c: Row) => {
    try {
      const cfg: Cfg = { config: c.config, secrets: getSecrets(c.id), label: c.label };
      const provider = aiProvider(cfg), model = aiModel(cfg);
      return model ? [{ id: c.id, label: c.label ?? AI_PROVIDERS[provider].label, provider, model, cfg }] : [];
    } catch { return []; }
  });
}
export const aiConnection = (id?: string) => { const all = aiConnections(); return (id ? all.find((c) => c.id === id) : undefined) ?? all[0] ?? null; };

const SYSTEM = (today: string, project?: string) => `Tu es l'assistant de Searchtide, le tableau de bord d'un entrepreneur qui suit plusieurs projets (sites, Search Console, revenus, CRM, publications sur les réseaux).
Nous sommes le ${today}. Réponds en français, simplement, comme à un entrepreneur pressé : la réponse d'abord, puis le détail utile.
Tes outils lisent les données de son instance. Appuie chaque chiffre sur un outil, et donne sa période et sa source (« Search Console, 28 derniers jours »).
Si une donnée manque (source non connectée, période vide), dis-le et indique quoi connecter ; n'invente jamais un chiffre et n'écris jamais 0 à la place d'une donnée absente.
Tu ne peux rien modifier : pour une action (publier, corriger un titre), décris-la et dis où la faire dans Searchtide.
Commence par portfolio_overview ou today si la question est générale.${project ? `\nLa question porte sur le projet « ${project} » : filtre tes lectures sur lui.` : ""}`;

/** Exécute un appel d'outil ; une erreur devient un texte que le modèle peut lire (jamais une exception). */
async function call(tools: CatalogTool[], name: string, args: Record<string, unknown>, used: Used[]): Promise<{ text: string; error: boolean }> {
  const t = tools.find((x) => x.name === name);
  if (!t) { used.push({ name, args, error: "outil inconnu" }); return { text: `Outil inconnu : ${name}`, error: true }; }
  try {
    const text = await t.run(args);
    used.push({ name, args });
    return { text: text.length > MAX_RESULT ? `${text.slice(0, MAX_RESULT)}\n… (résultat tronqué)` : text, error: false };
  } catch (e) {
    used.push({ name, args, error: (e as Error).message });
    return { text: `Erreur : ${(e as Error).message}`, error: true };
  }
}

type Fetch = typeof fetch;

/** Claude : SDK officiel, boucle d'outils manuelle (les outils exécutent du code de l'instance). */
async function withClaude(conn: AiConn, system: string, history: ChatTurn[], tools: CatalogTool[], used: Used[], f: Fetch) {
  const client = anthropicClient(conn.cfg, { fetch: f });
  const defs: Anthropic.Beta.BetaTool[] = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema as Anthropic.Beta.BetaTool.InputSchema }));
  const messages: Anthropic.Beta.BetaMessageParam[] = history.map((m) => ({ role: m.role, content: m.content }));
  for (let step = 0; step < MAX_STEPS; step++) {
    const r = await client.beta.messages.create({
      model: conn.model, max_tokens: 16000, system, tools: defs, messages,
      output_config: { effort: "medium" },
      // Repli côté serveur si le modèle décline : la question part sur un autre modèle dans le même appel.
      ...(conn.model.startsWith("claude-opus-5") || conn.model.startsWith("claude-fable-5") ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    });
    if (r.stop_reason === "refusal") return "Le modèle a refusé de répondre à cette question.";
    const text = r.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
    const uses = r.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (r.stop_reason === "pause_turn") { messages.push({ role: "assistant", content: r.content }); continue; }
    if (r.stop_reason !== "tool_use" || !uses.length) return text || "(réponse vide)";
    messages.push({ role: "assistant", content: r.content });
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const u of uses) {
      const out = await call(tools, u.name, (u.input ?? {}) as Record<string, unknown>, used);
      results.push({ type: "tool_result", tool_use_id: u.id, content: out.text, ...(out.error ? { is_error: true } : {}) });
    }
    messages.push({ role: "user", content: results });
  }
  return "Je n'ai pas pu terminer : trop d'étapes de lecture. Posez une question plus précise.";
}

/** OpenAI, Gemini et Ollama : API « chat completions » compatible, appels de fonctions. */
async function withChatCompletions(conn: AiConn, system: string, history: ChatTurn[], tools: CatalogTool[], used: Used[], f: Fetch) {
  const provider = conn.provider as keyof typeof AI_PROVIDERS;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (provider !== "ollama") headers.Authorization = `Bearer ${conn.cfg.secrets.api_key}`;
  const defs = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.schema } }));
  const messages: Row[] = [{ role: "system", content: system }, ...history];
  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await f(`${aiBase(conn.cfg)}/chat/completions`, { method: "POST", headers, body: JSON.stringify({ model: conn.model, messages, tools: defs }), signal: AbortSignal.timeout(180_000) });
    const j = await res.json().catch(() => ({})) as Row;
    if (!res.ok) throw new Error(`${AI_PROVIDERS[provider].label} répond ${res.status}${j.error?.message ? ` : ${String(j.error.message).slice(0, 200)}` : ""}`);
    const msg = j.choices?.[0]?.message ?? {};
    const calls: Row[] = msg.tool_calls ?? [];
    if (!calls.length) return String(msg.content ?? "").trim() || "(réponse vide)";
    messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: calls });
    for (const c of calls) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(String(c.function?.arguments ?? "{}")); } catch { /* arguments illisibles : l'outil le dira */ }
      const out = await call(tools, String(c.function?.name ?? ""), args, used);
      messages.push({ role: "tool", tool_call_id: c.id, content: out.text });
    }
  }
  return "Je n'ai pas pu terminer : trop d'étapes de lecture. Posez une question plus précise.";
}

/** Une question à l'assistant. `f` et `tools` sont remplaçables dans les tests. */
export async function ask(input: { messages: ChatTurn[]; connection_id?: string; project?: string }, o: { fetch?: Fetch; tools?: CatalogTool[]; today?: string } = {}) {
  const conn = aiConnection(input.connection_id);
  if (!conn) throw new Error("Aucune IA connectée : ajoutez votre clé Claude, ChatGPT ou Gemini (ou Ollama) dans Connexions → Intelligence artificielle.");
  const history = (input.messages ?? []).filter((m) => (m.role === "user" || m.role === "assistant") && String(m.content ?? "").trim())
    .slice(-20).map((m) => ({ role: m.role, content: String(m.content).slice(0, 8000) }));
  if (!history.length || history.at(-1)!.role !== "user") throw new Error("Posez une question");
  const tools = o.tools ?? readOnlyCatalog(`Assistant (${conn.label})`);
  const used: Used[] = [];
  const f = o.fetch ?? realCtx().fetch;
  const system = SYSTEM(o.today ?? new Date().toISOString().slice(0, 10), input.project);
  const answer = conn.provider === "anthropic" ? await withClaude(conn, system, history, tools, used, f) : await withChatCompletions(conn, system, history, tools, used, f);
  return { answer, used, model: conn.model, provider: conn.provider };
}

export function registerAssistant(app: Hono) {
  app.get("/api/assistant", (c) => isAdmin(c)
    ? c.json({ connections: aiConnections().map(({ id, label, provider, model }) => ({ id, label, provider, model })) })
    : c.json({ error: "Réservé à l'administrateur" }, 403));
  app.post("/api/assistant", async (c) => {
    if (!isAdmin(c)) return c.json({ error: "Réservé à l'administrateur" }, 403);
    if (process.env.DEMO === "1") return c.json({ error: "Désactivé en démonstration." }, 403);
    try { return c.json(await ask(await c.req.json().catch(() => ({})))); }
    catch (e) {
      const err = e as Error;
      const msg = err instanceof Anthropic.AuthenticationError ? "Clé Anthropic refusée : vérifiez-la dans Connexions"
        : err instanceof Anthropic.RateLimitError ? "Limite d'appels atteinte chez Anthropic : réessayez dans un instant"
        : err instanceof Anthropic.APIError ? `Anthropic répond ${err.status} : ${err.message.slice(0, 200)}` : err.message;
      return c.json({ error: msg }, 400);
    }
  });
}
