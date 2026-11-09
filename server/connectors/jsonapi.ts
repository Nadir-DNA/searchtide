// Connecteur « API JSON » : un chiffre exposé par une URL JSON (votre propre API, un outil interne). Le jeton n'est envoyé qu'au domaine autorisé.
import { register } from "./registry.ts";
import { ConnectorError, type Cfg, type Connector, type Ctx, type TestResult } from "./types.ts";

/** Origine autorisée : https://hôte[:port], ou http pour localhost (développement). */
export function parseOrigin(raw: string): URL {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new ConnectorError("format", "Le domaine autorisé doit ressembler à https://api.exemple.com."); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new ConnectorError("format", "Le domaine autorisé doit commencer par https:// (http:// n'est accepté que pour localhost).");
  return u;
}

function headersOf(c: Cfg): Record<string, string> {
  const token = String(c.secrets.token ?? "").trim();
  if (!token) return { Accept: "application/json" };
  const name = String(c.config.header || "Authorization").trim();
  if (!/^[A-Za-z0-9-]+$/.test(name)) throw new ConnectorError("format", "Nom d'en-tête invalide.");
  return { Accept: "application/json", [name]: name.toLowerCase() === "authorization" && !/^(Bearer|Basic|Token)\s/i.test(token) ? `Bearer ${token}` : token };
}

/** Valeur numérique à `path` (a.b.0.c) dans un JSON ; sans chemin, le JSON lui-même doit être un nombre. */
export function pickNumber(json: unknown, path: string): number {
  const v = Number(path ? path.split(".").reduce((o: any, k) => o?.[k], json) : json);
  if (!Number.isFinite(v)) throw new ConnectorError("format", `Pas de nombre à « ${path || "la racine"} »`);
  return v;
}

async function get(url: URL, c: Cfg, ctx: Ctx) {
  const origin = parseOrigin(String(c.config.origin ?? ""));
  if (url.origin !== origin.origin) throw new ConnectorError("format", `Cette adresse n'est pas sur le domaine autorisé (${origin.origin}) : le jeton ne lui est jamais envoyé.`);
  const res = await ctx.fetch(url.toString(), { headers: headersOf(c), redirect: "manual" });
  if (res.status >= 300 && res.status < 400) throw new ConnectorError("other", "L'adresse redirige ailleurs : indiquez l'adresse finale.");
  if (res.status === 401) throw new ConnectorError("auth", "L'API refuse ce jeton : vérifiez qu'il est complet et actif.");
  if (res.status === 403) throw new ConnectorError("permission", "Permission manquante : l'API refuse l'accès à cette adresse avec ce jeton.");
  return res;
}

export const jsonapi: Connector = {
  id: "jsonapi", name: "API JSON", provider: "L'API", monogram: "JS", category: "produit", minutes: 3,
  description: "Lit un chiffre dans la réponse JSON d'une URL (votre API, un outil interne). Le jeton n'est envoyé qu'au domaine autorisé.",
  unlocks: ["Tout chiffre exposé par une URL JSON"],
  fields: [
    { key: "origin", label: "Domaine autorisé", type: "url", required: true, placeholder: "https://api.exemple.com", help: "Les adresses des indicateurs doivent être sur ce domaine." },
    { key: "header", label: "En-tête du jeton", type: "text", default: "Authorization", help: "« Authorization » ajoute « Bearer » devant le jeton si besoin." },
    { key: "token", label: "Jeton (facultatif)", type: "text", secret: true },
  ],
  guide: [
    { text: "Indiquez le domaine de votre API (https://…). Rien d'autre n'est jamais appelé avec le jeton." },
    { text: "Collez le jeton si l'API en demande un (créez-en un en lecture seule chez vous)." },
    { text: "Au rattachement à un projet, vous donnerez l'adresse exacte et le chemin du nombre (ex. stats.users)." },
  ],
  hint(c) { try { const o = parseOrigin(String(c.config.origin ?? "")); const t = String(c.secrets.token ?? ""); return `${o.host}${t ? ` · jeton …${t.slice(-4)}` : " · sans jeton"}`; } catch { return "API JSON"; } },
  async test(c, ctx): Promise<TestResult> {
    const origin = parseOrigin(String(c.config.origin ?? ""));
    headersOf(c);
    const res = await get(new URL("/", origin), c, ctx);
    if (res.status >= 500) throw new ConnectorError("other", `L'API répond avec une erreur ${res.status}.`);
    return { ok: true, label: origin.host, detail: `${origin.host} répond (HTTP ${res.status}).` };
  },
  kpis: [
    { id: "json_daily", label: "Nombre lu dans une URL JSON (un chiffre par jour)", mode: "daily", params: [{ key: "url", label: "Adresse JSON", type: "url", required: true }, { key: "path", label: "Chemin du nombre", type: "text", placeholder: "stats.users" }] },
    { id: "json_total", label: "Nombre lu dans une URL JSON (un niveau)", mode: "total", params: [{ key: "url", label: "Adresse JSON", type: "url", required: true }, { key: "path", label: "Chemin du nombre", type: "text", placeholder: "stats.users" }] },
  ],
  presets: [{ kpi: "json_total", label: "Nombre lu dans l'API (niveau)" }, { kpi: "json_daily", label: "Nombre lu dans l'API (un chiffre par jour)" }],
  toIndicator: (_kpi, p) => ({ source: "http", config: { url: String(p.url ?? ""), path: String(p.path ?? "") } }),
  async collect(c, _k, p, _d, ctx) {
    let url: URL;
    try { url = new URL(String(p.url ?? "")); } catch { throw new ConnectorError("format", "Adresse JSON invalide."); }
    const res = await get(url, c, ctx);
    if (!res.ok) throw new ConnectorError("other", `L'API répond HTTP ${res.status}.`);
    return pickNumber(await res.json().catch(() => { throw new ConnectorError("format", "La réponse n'est pas du JSON."); }), String(p.path ?? ""));
  },
};
register(jsonapi);
