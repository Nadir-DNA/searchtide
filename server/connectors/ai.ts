// Connecteur « IA » (plans B2, B3, B5) : la clé d'API de l'utilisateur chez Anthropic, OpenAI ou Google, ou un modèle
// local servi par Ollama. Sert à l'assistant, aux briefs d'articles et à la visibilité dans les IA. Aucun KPI relevé.
// Le test ne fait que lister les modèles (lecture seule, gratuit).
import Anthropic from "@anthropic-ai/sdk";
import { register } from "./registry.ts";
import { ConnectorError, type Cfg, type Connector, type Ctx, type TestResult } from "./types.ts";

export const AI_PROVIDERS = {
  anthropic: { label: "Claude (Anthropic)", defaultModel: "claude-opus-5-5", base: "https://api.anthropic.com" },
  openai: { label: "ChatGPT (OpenAI)", defaultModel: "", base: "https://api.openai.com/v1" },
  gemini: { label: "Gemini (Google)", defaultModel: "", base: "https://generativelanguage.googleapis.com/v1beta/openai" },
  ollama: { label: "Modèle local (Ollama)", defaultModel: "", base: "http://127.0.0.1:11434/v1" },
} as const;
export type AiProvider = keyof typeof AI_PROVIDERS;

export const aiProvider = (c: Cfg): AiProvider => {
  const p = String(c.config.provider ?? "");
  if (!(p in AI_PROVIDERS)) throw new ConnectorError("format", "Choisissez le fournisseur d'IA");
  return p as AiProvider;
};
export const aiModel = (c: Cfg) => String(c.config.model ?? "").trim() || AI_PROVIDERS[aiProvider(c)].defaultModel;
/** Adresse de l'API compatible OpenAI (OpenAI, Gemini, Ollama). Ollama : l'adresse choisie par l'administrateur, même locale. */
export const aiBase = (c: Cfg) => {
  const p = aiProvider(c);
  if (p !== "ollama") return AI_PROVIDERS[p].base;
  const raw = String(c.config.base_url ?? "").trim() || AI_PROVIDERS.ollama.base;
  let u: URL;
  try { u = new URL(raw); } catch { throw new ConnectorError("format", "Adresse d'Ollama invalide (ex. http://127.0.0.1:11434)"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new ConnectorError("format", "Adresse d'Ollama en http ou https");
  return `${u.origin}${u.pathname.replace(/\/$/, "").replace(/\/v1$/, "")}/v1`;
};

export const anthropicClient = (c: Cfg, ctx: Pick<Ctx, "fetch">) =>
  new Anthropic({ apiKey: String(c.secrets.api_key ?? ""), fetch: ctx.fetch as any, maxRetries: 1 });

export const ai: Connector = {
  id: "ai", name: "Intelligence artificielle", provider: "le fournisseur d'IA", monogram: "IA", category: "seo", minutes: 2,
  description: "Votre clé Claude, ChatGPT ou Gemini, ou un modèle local (Ollama) : assistant, briefs d'articles et visibilité de vos sites dans les réponses des IA.",
  unlocks: ["Assistant qui répond sur vos données", "Brouillons d'articles à partir d'un brief", "Visibilité dans les réponses des IA"],
  fields: [
    { key: "provider", label: "Fournisseur", type: "select", required: true, options: Object.entries(AI_PROVIDERS).map(([value, p]) => ({ value, label: p.label })) },
    { key: "api_key", label: "Clé d'API", type: "text", secret: true, help: "Créée dans la console du fournisseur. Inutile pour Ollama. Les appels sont facturés par le fournisseur, à l'usage." },
    { key: "model", label: "Modèle", type: "text", placeholder: "claude-opus-5-5, gpt-…, gemini-…, llama3.1…", help: "Vide pour Claude : claude-opus-5-5. Obligatoire pour les autres fournisseurs." },
    { key: "base_url", label: "Adresse d'Ollama", type: "url", placeholder: "http://127.0.0.1:11434", help: "Seulement pour un modèle local." },
  ],
  guide: [
    { text: "Claude : console.anthropic.com → API Keys.", url: "https://console.anthropic.com/settings/keys" },
    { text: "ChatGPT : platform.openai.com → API keys.", url: "https://platform.openai.com/api-keys" },
    { text: "Gemini : aistudio.google.com → Get API key.", url: "https://aistudio.google.com/apikey" },
    { text: "Ollama : installez-le sur la machine de Searchtide (ollama.com), puis « ollama pull » d'un modèle qui sait appeler des outils." },
  ],
  readPosts: [],
  hint(c) { try { return `${AI_PROVIDERS[aiProvider(c)].label} · ${aiModel(c) || "modèle à choisir"}`; } catch { return "IA"; } },
  async test(c, ctx): Promise<TestResult> {
    const p = aiProvider(c), model = aiModel(c);
    if (p !== "ollama" && !String(c.secrets.api_key ?? "").trim()) throw new ConnectorError("auth", "Clé d'API requise");
    if (!model) throw new ConnectorError("format", "Indiquez le modèle à utiliser");
    if (p === "anthropic") {
      try {
        const m = await anthropicClient(c, ctx).models.retrieve(model);
        return { ok: true, label: AI_PROVIDERS[p].label, account: m.display_name ?? model, detail: `Modèle ${m.display_name ?? model} disponible` };
      } catch (e) {
        if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw new ConnectorError("auth", "Clé refusée par Anthropic");
        if (e instanceof Anthropic.NotFoundError) throw new ConnectorError("format", `Modèle inconnu chez Anthropic : ${model}`);
        throw e;
      }
    }
    const r = await ctx.fetch(`${aiBase(c)}/models`, { headers: p === "ollama" ? {} : { Authorization: `Bearer ${c.secrets.api_key}` }, signal: AbortSignal.timeout(ctx.timeoutMs) });
    if (r.status === 401 || r.status === 403) throw new ConnectorError("auth", `Clé refusée par ${AI_PROVIDERS[p].label}`);
    if (!r.ok) throw new ConnectorError("other", `${AI_PROVIDERS[p].label} répond ${r.status}`);
    const ids: string[] = ((await r.json().catch(() => ({}))) as any).data?.map((m: any) => String(m.id).replace(/^models\//, "")) ?? [];
    const warnings = ids.length && !ids.includes(model) ? [`Modèle « ${model} » absent de la liste du fournisseur : vérifiez son nom`] : [];
    return { ok: true, label: AI_PROVIDERS[p].label, account: model, detail: `${ids.length} modèle(s) disponible(s)`, warnings };
  },
};
register(ai);
