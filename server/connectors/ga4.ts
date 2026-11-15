// Connecteur Google Analytics 4 (plan A7) : pour ceux qui ont déjà GA, un compte de service ajouté comme « Lecteur » de la
// propriété lit sessions, utilisateurs, événements clés, visites issues de Google et revenus. API Data v1 (runReport).
import { register } from "./registry.ts";
import { ConnectorError, type Cfg, type Connector, type Ctx, type TestResult } from "./types.ts";
import { googleAccessToken, parseServiceAccount } from "./google.ts";

export const GA_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
const METRICS: Record<string, { metric: string; organic?: boolean }> = {
  sessions: { metric: "sessions" }, active_users: { metric: "activeUsers" }, key_events: { metric: "keyEvents" },
  organic_sessions: { metric: "sessions", organic: true }, revenue: { metric: "totalRevenue" },
};
const property = (c: Cfg) => {
  const p = String(c.config.property_id ?? "").trim().replace(/^properties\//, "");
  if (!/^\d{6,12}$/.test(p)) throw new ConnectorError("format", "Identifiant de propriété GA4 : un nombre (Administration → Paramètres de la propriété), pas l'ID de mesure G-…");
  return p;
};

/** Une mesure GA4 sur une plage de dates (jours au format AAAA-MM-JJ, inclus). */
export async function gaReport(c: Cfg, ctx: Ctx, metric: string, from: string, to: string, organic = false): Promise<number> {
  const token = await googleAccessToken(parseServiceAccount(String(c.secrets.json ?? "")), GA_SCOPE, ctx);
  const res = await ctx.fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${property(c)}:runReport`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      dateRanges: [{ startDate: from, endDate: to }], metrics: [{ name: metric }],
      ...(organic ? { dimensionFilter: { filter: { fieldName: "sessionDefaultChannelGroup", stringFilter: { value: "Organic Search" } } } } : {}),
    }),
  });
  const data = await res.json().catch(() => ({})) as any;
  if (res.status === 401) throw new ConnectorError("auth", "Google refuse cette clé : vérifiez qu'elle est complète et active.");
  if (res.status === 403) throw new ConnectorError("permission", String(data.error?.message ?? "").includes("API has not been used")
    ? "Activez « Google Analytics Data API » dans votre projet Google Cloud."
    : "Accès refusé à la propriété : ajoutez l'adresse du compte de service comme « Lecteur » dans GA4 (Administration → Gestion des accès).");
  if (!res.ok) throw new ConnectorError("other", `Google Analytics ${res.status} : ${String(data.error?.message ?? "erreur").slice(0, 160)}`);
  return Number(data.rows?.[0]?.metricValues?.[0]?.value ?? 0) || 0;
}

const KPI = (id: string, label: string, money = false) => ({ id, label, mode: "daily" as const, backfill: true, ...(money ? { money: true } : {}) });

export const ga4: Connector = {
  id: "ga4", name: "Google Analytics 4", provider: "Google Analytics", monogram: "GA", category: "seo", minutes: 10,
  description: "Pour ceux qui utilisent déjà GA4 : sessions, utilisateurs, événements clés (conversions), visites venues de Google et revenus, jour par jour.",
  unlocks: ["Sessions et utilisateurs actifs", "Événements clés (conversions)", "Sessions issues de la recherche Google", "Revenus (e-commerce GA4)"],
  fields: [
    { key: "property_id", label: "Identifiant de la propriété", type: "text", required: true, placeholder: "123456789", help: "GA4 → Administration → Paramètres de la propriété. Un nombre, pas « G-… »." },
    { key: "json", label: "Clé du compte de service (fichier JSON)", type: "json", secret: true, required: true, help: "Le même fichier que pour la connexion Google convient. Chiffré, jamais réaffiché." },
  ],
  guide: [
    { text: "Dans votre projet Google Cloud, activez « Google Analytics Data API ».", url: "https://console.cloud.google.com/apis/library/analyticsdata.googleapis.com" },
    { text: "Utilisez la clé JSON du compte de service de la connexion Google (ou créez-en une).", url: "https://console.cloud.google.com/iam-admin/serviceaccounts" },
    { text: "Dans GA4 : Administration → Gestion des accès à la propriété → ajoutez l'adresse du compte de service comme « Lecteur »." },
    { text: "Copiez l'identifiant de la propriété (Administration → Paramètres de la propriété) et collez-le ici." },
  ],
  revokeUrl: "https://analytics.google.com/analytics/web/",
  readPosts: ["POST https://oauth2.googleapis.com/token", "POST https://analyticsdata.googleapis.com/v1beta/properties/"],
  hint(c) { try { return `propriété ${property(c)} · ${parseServiceAccount(String(c.secrets.json ?? "")).client_email}`; } catch { return "propriété GA4"; } },
  async test(c, ctx): Promise<TestResult> {
    const sa = parseServiceAccount(String(c.secrets.json ?? ""));
    const to = ctx.now().toISOString().slice(0, 10), from = new Date(ctx.now().getTime() - 6 * 86_400_000).toISOString().slice(0, 10);
    const sessions = await gaReport(c, ctx, "sessions", from, to);
    return { ok: true, label: `GA4 ${property(c)}`, account: sa.client_email, detail: `${sessions.toLocaleString("fr-FR")} sessions sur 7 jours`, warnings: sessions ? [] : ["Aucune session sur 7 jours : vérifiez la propriété choisie."] };
  },
  kpis: [KPI("sessions", "Sessions (GA4)"), KPI("active_users", "Utilisateurs actifs (GA4)"), KPI("key_events", "Événements clés (GA4)"), KPI("organic_sessions", "Sessions venues de Google (GA4)"), KPI("revenue", "Revenus (GA4)", true)],
  presets: [{ kpi: "sessions", label: "Sessions (GA4)" }, { kpi: "key_events", label: "Événements clés (GA4)" }, { kpi: "organic_sessions", label: "Sessions venues de Google (GA4)" }],
  toIndicator: (kpi) => ({ source: "ga4", config: { metric: kpi.id } }),
  async collect(c, kpi, _params, day, ctx) {
    const m = METRICS[kpi.id];
    if (!m) throw new ConnectorError("format", `Mesure GA4 inconnue : ${kpi.id}`);
    const d = day ?? ctx.now().toISOString().slice(0, 10);
    return gaReport(c, ctx, m.metric, d, d, m.organic);
  },
};
register(ga4);
