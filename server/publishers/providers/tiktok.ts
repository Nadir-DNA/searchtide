// SPDX-License-Identifier: AGPL-3.0-only
// Fournisseur TikTok (Content Posting API, publication directe d'une vidéo).
// D'après Postiz (tiktok.provider.ts), Copyright (C) 2025 Nevo David, https://github.com/gitroomhq/postiz-app ;
// réécrit : envoi en un seul morceau (médias de 25 Mo au plus), suivi d'état par `poll`.
import { registerProvider, type Provider, type PublishResult, type Tokens } from "../provider.ts";
import { f, fail, json, pending } from "./http.ts";

const API = "https://open.tiktokapis.com/v2";
const env = () => ({ id: process.env.TIKTOK_CLIENT_KEY ?? "", secret: process.env.TIKTOK_CLIENT_SECRET ?? "" });
const bearer = (t: string) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json; charset=UTF-8" });
/** Confidentialité de Searchtide → niveau TikTok. */
export const PRIVACY: Record<string, string> = { public: "PUBLIC_TO_EVERYONE", unlisted: "FOLLOWER_OF_CREATOR", private: "SELF_ONLY" };

async function token(body: Record<string, string>) {
  const { id, secret } = env();
  const r = await f(`${API}/oauth/token/`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...body, client_key: id, client_secret: secret }) });
  const j = await json(r);
  if (!r.ok || !j.access_token) throw new Error(`TikTok a refusé l'autorisation (${r.status}${j.error ? ` ${j.error}` : ""})`);
  return { accessToken: String(j.access_token), refreshToken: j.refresh_token ? String(j.refresh_token) : undefined, expiresAt: j.expires_in ? Date.now() + Number(j.expires_in) * 1000 : undefined, openId: String(j.open_id ?? "") };
}

/** Erreur TikTok (`error.code`) avant la publication : rien n'est parti. */
function tiktokError(status: number, e: any): PublishResult {
  const code = String(e?.code ?? ""), msg = String(e?.message ?? "").slice(0, 200);
  if (status === 401 || code === "access_token_invalid" || code === "scope_not_authorized") return fail("auth", "TikTok : jeton refusé, reconnectez le compte");
  if (status === 429 || code === "rate_limit_exceeded") return fail("rate", "TikTok : limite de débit atteinte");
  if (code === "spam_risk_too_many_posts" || code === "reached_active_user_cap") return fail("quota", `TikTok : quota atteint (${code})`);
  if (status >= 500) return fail("network", `TikTok : erreur ${status}`);
  return fail("format", `TikTok a refusé la vidéo (${code || status}) ${msg}`.trim());
}

export const tiktok: Provider = {
  id: "tiktok", label: "TikTok", env: ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"],
  limits: { text: 2200, media: 1 },
  configured: () => !!env().id && !!env().secret,
  check: ({ media, visibility }) => [
    ...(media.length !== 1 || !media[0].mime.startsWith("video/") ? ["TikTok : une seule vidéo (les photos viendront plus tard)"] : []),
    ...(visibility && !PRIVACY[visibility] ? [`TikTok : confidentialité inconnue (${visibility})`] : []),
  ],
  authUrl: (redirectUri, state) => `https://www.tiktok.com/v2/auth/authorize/?${new URLSearchParams({ client_key: env().id, scope: "user.info.basic,video.publish", response_type: "code", redirect_uri: redirectUri, state })}`,
  async exchange(code, redirectUri) {
    const t = await token({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
    const r = await f(`${API}/user/info/?fields=open_id,display_name,username`, { headers: { Authorization: `Bearer ${t.accessToken}` } });
    const u = (await json(r)).data?.user ?? {};
    return [{ accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt, accountId: String(u.open_id ?? t.openId), name: `@${u.username ?? u.display_name ?? "tiktok"}` } satisfies Tokens];
  },
  refresh: (refreshToken) => token({ grant_type: "refresh_token", refresh_token: refreshToken }),

  async publish({ text, visibility, media }, t) {
    const video = media[0];
    try {
      // La confidentialité doit faire partie des options du compte (une application non auditée n'a que SELF_ONLY).
      const ci = await f(`${API}/post/publish/creator_info/query/`, { method: "POST", headers: bearer(t) });
      const cj = await json(ci);
      if (!ci.ok || (cj.error?.code && cj.error.code !== "ok")) return tiktokError(ci.status, cj.error);
      const level = PRIVACY[visibility ?? ""] ?? "SELF_ONLY", options: string[] = cj.data?.privacy_level_options ?? [];
      if (options.length && !options.includes(level)) return fail("format", `TikTok : confidentialité ${level} non autorisée pour ce compte (possibles : ${options.join(", ")})`);
      const init = await f(`${API}/post/publish/video/init/`, {
        method: "POST", headers: bearer(t),
        body: JSON.stringify({
          post_info: { title: text, privacy_level: level, disable_comment: false, disable_duet: false, disable_stitch: false },
          source_info: { source: "FILE_UPLOAD", video_size: video.size, chunk_size: video.size, total_chunk_count: 1 },
        }),
      });
      const ij = await json(init);
      if (!init.ok || !ij.data?.publish_id || !ij.data?.upload_url) return tiktokError(init.status, ij.error);
      // Sans envoi complet du fichier, TikTok ne publie rien : un échec ici est certain.
      const up = await f(String(ij.data.upload_url), { method: "PUT", headers: { "Content-Type": video.mime, "Content-Range": `bytes 0-${video.size - 1}/${video.size}` }, body: new Uint8Array(video.bytes()) });
      if (!up.ok) return fail(up.status >= 500 ? "network" : "format", `TikTok : envoi de la vidéo refusé (${up.status})`);
      return pending("TikTok traite la vidéo", { publishId: String(ij.data.publish_id), username: String(cj.data?.creator_username ?? "") });
    } catch (e) { return fail("network", `TikTok : envoi impossible (${(e as Error).message})`); }
  },

  async poll(data, t) {
    let j: any;
    try {
      const r = await f(`${API}/post/publish/status/fetch/`, { method: "POST", headers: bearer(t), body: JSON.stringify({ publish_id: data.publishId }) });
      j = await json(r);
      if (!r.ok) return r.status === 401 ? fail("to_verify", "TikTok : jeton refusé pendant le traitement, vérifiez sur le réseau") : pending("TikTok ne répond pas", data);
    } catch { return pending("TikTok ne répond pas, nouvelle lecture plus tard", data); }
    const s = String(j.data?.status ?? "");
    if (s === "FAILED") return fail("refused", `TikTok a refusé la vidéo (${j.data?.fail_reason ?? "raison inconnue"})`);
    if (s !== "PUBLISH_COMPLETE") return pending("TikTok traite la vidéo", data);
    const id = j.data?.publicaly_available_post_id?.[0], user = String(data.username ?? "");
    // Une vidéo privée n'a pas d'identifiant public : la preuve est le profil.
    return { ok: true, url: id && user ? `https://www.tiktok.com/@${user}/video/${id}` : `https://www.tiktok.com/${user ? `@${user}` : ""}` };
  },
};

registerProvider(tiktok);
