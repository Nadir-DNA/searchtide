// Connecteur PageSpeed Insights : scores de performance et de SEO, LCP et CLS d'une page. La clé API est facultative.
// Un relevé dure souvent plus de 10 s (Lighthouse tourne chez Google) : le test s'arrête à 60 % du délai (6 s) sans erreur de clé, ce qui prouve que la clé est acceptée.
import { register } from "./registry.ts";
import { ConnectorError, type Cfg, type Connector, type Ctx, type TestResult } from "./types.ts";

const API = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
const REFUSED = "PageSpeed refuse cette clé : vérifiez qu'elle est complète et active.";
const keyOf = (c: Cfg) => String(c.secrets.key ?? "").trim();

function query(url: string, strategy: string, key: string) {
  const q = new URLSearchParams({ url, strategy });
  q.append("category", "performance"); q.append("category", "seo");
  if (key) q.set("key", key);
  return `${API}?${q}`;
}

async function failure(res: Response): Promise<ConnectorError> {
  const j = await res.json().catch(() => ({})) as { error?: { message?: string; status?: string; errors?: { reason?: string }[] } };
  const reason = j.error?.errors?.[0]?.reason ?? "", msg = j.error?.message ?? "";
  if (res.status === 400 && /api key|keyInvalid/i.test(reason + msg)) return new ConnectorError("auth", REFUSED);
  if (res.status === 403) return new ConnectorError("permission", "Permission manquante : activez l'API PageSpeed Insights dans le projet Google Cloud de cette clé.");
  if (res.status === 429) return new ConnectorError("other", "Quota PageSpeed dépassé : réessayez plus tard, ou ajoutez une clé API (connexion PageSpeed).");
  return new ConnectorError("other", `PageSpeed ${res.status} : ${msg.slice(0, 200) || "erreur"}`);
}

/** Mesure d'une page : note sur 100 (performance, SEO), LCP en secondes, CLS. */
export async function pagespeedMetric(a: { url: string; metric: string; strategy: string; key?: string }, ctx: Ctx): Promise<number> {
  const res = await ctx.fetch(query(a.url, a.strategy, a.key ?? ""), { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw await failure(res);
  const l = ((await res.json()) as any).lighthouseResult;
  if (!l) throw new ConnectorError("other", "PageSpeed n'a pas renvoyé de résultat pour cette page.");
  if (a.metric === "performance" || a.metric === "seo") return Math.round(l.categories[a.metric].score * 100);
  if (a.metric === "lcp") return Math.round(l.audits["largest-contentful-paint"].numericValue / 10) / 100;
  if (a.metric === "cls") return Math.round(l.audits["cumulative-layout-shift"].numericValue * 1000) / 1000;
  throw new Error(`Mesure PageSpeed inconnue : ${a.metric}`);
}

const params = [
  { key: "url", label: "Adresse de la page", type: "url" as const, required: true, placeholder: "https://exemple.com/" },
  { key: "strategy", label: "Appareil", type: "select" as const, default: "mobile", options: [{ value: "mobile", label: "Mobile" }, { value: "desktop", label: "Ordinateur" }] },
];

export const pagespeed: Connector = {
  id: "pagespeed", name: "PageSpeed", provider: "PageSpeed", monogram: "PS", category: "seo", minutes: 1, singleton: true,
  description: "Mesure la vitesse et le SEO technique d'une page avec Google PageSpeed Insights, une fois par jour. La clé API est facultative.",
  unlocks: ["Score de performance", "Score SEO", "LCP (secondes)", "CLS"],
  fields: [{ key: "key", label: "Clé API (facultative)", type: "text", secret: true, help: "Sans clé, Google peut limiter les relevés (quota partagé). Avec une clé, vous avez votre propre quota." }],
  guide: [
    { text: "Ouvrez les identifiants Google Cloud, puis « Créer des identifiants » → « Clé API ».", url: "https://console.cloud.google.com/apis/credentials" },
    { text: "Activez l'API « PageSpeed Insights » dans le même projet si Google le demande." },
    { text: "Collez la clé (ou laissez vide pour essayer sans clé)." },
  ],
  revokeUrl: "https://console.cloud.google.com/apis/credentials",
  hint(c) { const k = keyOf(c); return k ? `clé …${k.slice(-4)}` : "sans clé"; },
  async test(c, ctx): Promise<TestResult> {
    const key = keyOf(c);
    const ac = new AbortController();
    const stop = setTimeout(() => ac.abort(), Math.max(50, Math.round(ctx.timeoutMs * 0.6))); // 6 s avec le délai de 10 s
    try {
      const res = await ctx.fetch(query("https://www.example.com/", "mobile", key), { signal: ac.signal });
      if (!res.ok) throw await failure(res);
      // Google a répondu : la clé est acceptée
    } catch (e) {
      // Pas d'erreur de clé avant l'arrêt : Lighthouse est en train de mesurer, la clé est acceptée (ou l'essai sans clé passe)
      if (!(ac.signal.aborted && !(e instanceof ConnectorError))) throw e;
    } finally { clearTimeout(stop); }
    return {
      ok: true, label: key ? "PageSpeed (clé API)" : "PageSpeed (sans clé)", detail: key ? "Clé acceptée par Google." : "Essai sans clé accepté.",
      warnings: key ? [] : ["Sans clé, Google peut limiter les relevés (quota partagé) : ajoutez une clé API si cela arrive."],
    };
  },
  kpis: [
    { id: "performance", label: "Score de performance", mode: "total", params },
    { id: "seo", label: "Score SEO", mode: "total", params },
    { id: "lcp", label: "LCP", unit: "s", mode: "total", params },
    { id: "cls", label: "CLS", mode: "total", params },
  ],
  presets: [{ kpi: "performance", label: "Score de performance" }, { kpi: "seo", label: "Score SEO" }, { kpi: "lcp", label: "LCP" }, { kpi: "cls", label: "CLS" }],
  async collect(c, kpi, p, _d, ctx) {
    const url = String(p.url ?? "");
    try { if (!/^https?:$/.test(new URL(url).protocol)) throw 0; } catch { throw new ConnectorError("format", "Adresse de page invalide (https://…)."); }
    return pagespeedMetric({ url, metric: kpi.id, strategy: p.strategy === "desktop" ? "desktop" : "mobile", key: keyOf(c) }, ctx);
  },
};
register(pagespeed);
