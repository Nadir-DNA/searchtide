// SPDX-License-Identifier: AGPL-3.0-only
// Fournisseur LinkedIn (texte). Ce fichier est sous AGPL-3.0 (voir ./LICENSE), contrairement au reste de Searchtide (MIT).
// Dérivé en partie de Postiz, libraries/nestjs-libraries/src/integrations/social/linkedin.provider.ts
// Postiz - Social media schedule tool, Copyright (C) 2025 Nevo David — https://github.com/gitroomhq/postiz-app
// Modifications : réécrit sans NestJS ni Temporal ; portées minimales (openid, profile, w_member_social) ;
// erreurs ramenées au contrat PublishResult ; un doute après l'envoi renvoie to_verify, jamais un nouvel essai.
import { registerProvider, type PublishResult, type Provider, type Tokens } from "../provider.ts";

const API = "https://api.linkedin.com";
const VERSION = "202601";
const TIMEOUT = 30_000;
const SCOPES = ["openid", "profile", "w_member_social"];

/** Format de texte de LinkedIn : ces caractères sont réservés et tronquent le message s'ils ne sont pas échappés. */
export const escapeCommentary = (t: string) => t.replace(/[\\|{}@[\]()<>#*_~]/g, (c) => `\\${c}`);

const env = () => ({ id: process.env.LINKEDIN_CLIENT_ID ?? "", secret: process.env.LINKEDIN_CLIENT_SECRET ?? "" });
const f = (url: string, init: RequestInit = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) });

async function token(body: Record<string, string>): Promise<Tokens> {
  const { id, secret } = env();
  const r = await f("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...body, client_id: id, client_secret: secret }),
  });
  const j = await r.json().catch(() => ({})) as any;
  if (!r.ok || !j.access_token) throw new Error(`LinkedIn a refusé l'autorisation (${r.status}${j.error ? ` ${j.error}` : ""})`);
  const u = await f(`${API}/v2/userinfo`, { headers: { Authorization: `Bearer ${j.access_token}` } });
  const me = await u.json().catch(() => ({})) as any;
  if (!u.ok || !me.sub) throw new Error(`Profil LinkedIn illisible (${u.status})`);
  return {
    accessToken: j.access_token, refreshToken: j.refresh_token || undefined,
    expiresAt: j.expires_in ? Date.now() + Number(j.expires_in) * 1000 : undefined,
    accountId: String(me.sub), name: String(me.name ?? "LinkedIn"),
  };
}

export const linkedin: Provider = {
  id: "linkedin",
  label: "LinkedIn",
  env: ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"],
  limits: { text: 3000, media: 0 },
  configured: () => !!env().id && !!env().secret,
  authUrl: (redirectUri, state) => `https://www.linkedin.com/oauth/v2/authorization?${new URLSearchParams({
    response_type: "code", client_id: env().id, redirect_uri: redirectUri, state, scope: SCOPES.join(" "),
  })}`,
  exchange: async (code, redirectUri) => [await token({ grant_type: "authorization_code", code, redirect_uri: redirectUri })],
  refresh: (refreshToken) => token({ grant_type: "refresh_token", refresh_token: refreshToken }),

  async publish({ text }, accessToken, accountId): Promise<PublishResult> {
    let r: Response;
    try {
      r = await f(`${API}/rest/posts`, {
        method: "POST",
        headers: { "LinkedIn-Version": VERSION, "X-Restli-Protocol-Version": "2.0.0", "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          author: `urn:li:person:${accountId}`, commentary: escapeCommentary(text), visibility: "PUBLIC",
          distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
          lifecycleState: "PUBLISHED", isReshareDisabledByAuthor: false,
        }),
      });
    } catch (e) {
      // Délai ou coupure : LinkedIn n'offre aucune clé d'idempotence, le post a pu partir.
      return { ok: false, kind: "to_verify", message: `Réponse de LinkedIn inconnue : ${(e as Error).message}` };
    }
    if (r.status === 201 || r.status === 200) {
      const urn = r.headers.get("x-restli-id");
      return urn ? { ok: true, url: `https://www.linkedin.com/feed/update/${encodeURIComponent(urn)}/` }
        : { ok: false, kind: "to_verify", message: "LinkedIn a accepté sans renvoyer l'identifiant du post" };
    }
    const detail = (await r.text().catch(() => "")).slice(0, 200);
    if (r.status === 401) return { ok: false, kind: "auth", message: "Jeton LinkedIn refusé : reconnectez le compte" };
    if (r.status === 403) return { ok: false, kind: "auth", message: "Autorisation LinkedIn insuffisante : reconnectez le compte" };
    if (r.status === 429) return { ok: false, kind: "rate", message: "Limite de débit LinkedIn atteinte" };
    if (r.status >= 500) return { ok: false, kind: "to_verify", message: `Erreur LinkedIn ${r.status} : vérifiez sur le réseau` };
    return { ok: false, kind: "format", message: `LinkedIn a refusé le post (${r.status}) ${detail}`.trim() };
  },
};

registerProvider(linkedin);
