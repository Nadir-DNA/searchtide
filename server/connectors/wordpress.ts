// Connecteur WordPress (plan B4) : l'API REST du site avec un mot de passe d'application (Utilisateurs → Profil →
// Mots de passe d'application). Sert à publier des articles et à corriger un titre ; aucun KPI relevé.
import { register } from "./registry.ts";
import { ConnectorError, type Cfg, type Connector, type Ctx, type TestResult } from "./types.ts";
import { checkUrl } from "../safe-fetch.ts";

export const wpBase = (c: Cfg) => {
  let u: URL;
  try { u = checkUrl(String(c.config.url ?? "")); } catch { throw new ConnectorError("format", "Adresse du site invalide : https://votre-site.fr"); }
  if (u.protocol !== "https:") throw new ConnectorError("format", "L'adresse du site doit commencer par https:// (le mot de passe d'application circule dans chaque requête).");
  return `${u.origin}${u.pathname.replace(/\/$/, "")}`;
};
export const wpAuth = (c: Cfg) => `Basic ${Buffer.from(`${c.config.user}:${String(c.secrets.app_password ?? "").replace(/\s+/g, "")}`).toString("base64")}`;

/** Appel de l'API REST WordPress ; les erreurs deviennent des messages lisibles. */
export async function wpFetch(c: Cfg, ctx: Ctx, path: string, init: { method?: string; body?: unknown } = {}) {
  const res = await ctx.fetch(`${wpBase(c)}/wp-json/wp/v2${path}`, {
    method: init.method ?? "GET", headers: { Authorization: wpAuth(c), "Content-Type": "application/json", Accept: "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body), redirect: "error", signal: AbortSignal.timeout(ctx.timeoutMs),
  });
  const data = await res.json().catch(() => ({})) as any;
  if (res.status === 401 || res.status === 403) throw new ConnectorError("auth", `WordPress refuse l'accès (${data.code ?? res.status}) : vérifiez l'identifiant et le mot de passe d'application, et le droit de publier.`);
  if (res.status === 404 && data.code === "rest_no_route") throw new ConnectorError("format", "L'API REST de WordPress est introuvable à cette adresse (désactivée par une extension ?).");
  if (!res.ok) throw new ConnectorError("other", `WordPress ${res.status} : ${String(data.message ?? "erreur").slice(0, 160)}`);
  return data;
}

export const wordpress: Connector = {
  id: "wordpress", name: "WordPress", provider: "WordPress", monogram: "WP", category: "seo", minutes: 3,
  description: "Publie vos articles et applique les corrections de titre proposées par Searchtide, après votre validation.",
  unlocks: ["Publication d'articles", "Corrections de titre appliquées au site"],
  fields: [
    { key: "url", label: "Adresse du site", type: "url", required: true, placeholder: "https://monsite.fr" },
    { key: "user", label: "Identifiant WordPress", type: "text", required: true },
    { key: "app_password", label: "Mot de passe d'application", type: "text", secret: true, required: true, help: "Créé dans WordPress : Utilisateurs → Profil → Mots de passe d'application. Ce n'est pas votre mot de passe de connexion." },
  ],
  guide: [
    { text: "Dans WordPress, ouvrez Utilisateurs → Profil, section « Mots de passe d'application »." },
    { text: "Donnez un nom (Searchtide), créez-le et copiez-le ici avec votre identifiant." },
    { text: "Utilisez « Tester » : Searchtide vérifie que ce compte peut publier." },
  ],
  revokeUrl: "https://wordpress.org/documentation/article/application-passwords/",
  readPosts: [],
  hint(c) { try { return `${new URL(String(c.config.url)).host} · ${c.config.user}`; } catch { return String(c.config.user ?? ""); } },
  async test(c, ctx): Promise<TestResult> {
    const me = await wpFetch(c, ctx, "/users/me?context=edit");
    const caps = me.capabilities ?? {};
    const warnings = caps.publish_posts || caps.administrator || caps.editor ? [] : ["Ce compte ne semble pas pouvoir publier : les articles resteront en brouillon."];
    return { ok: true, label: new URL(wpBase(c)).host, account: String(me.name ?? c.config.user), detail: `Connecté en tant que ${me.name ?? c.config.user}`, warnings };
  },
};
register(wordpress);
