// SPDX-License-Identifier: AGPL-3.0-only
// Fournisseur YouTube (Data API v3) : OAuth Google avec PKCE, envoi « resumable » d'une vidéo.
// Écrit pour Searchtide sur le modèle des fournisseurs Postiz (youtube.provider.ts), Copyright (C) 2025 Nevo David,
// https://github.com/gitroomhq/postiz-app ; portées réduites à l'envoi et à la lecture de la chaîne.
import { registerProvider, type Provider, type Tokens } from "../provider.ts";
import { before, challenge, f, fail, final, json, unknown } from "./http.ts";

const SCOPES = ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"];
const env = () => ({ id: process.env.YOUTUBE_CLIENT_ID ?? "", secret: process.env.YOUTUBE_CLIENT_SECRET ?? "" });

async function token(body: Record<string, string>) {
  const { id, secret } = env();
  const r = await f("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...body, client_id: id, client_secret: secret }) });
  const j = await json(r);
  if (!r.ok || !j.access_token) throw new Error(`Google a refusé l'autorisation (${r.status}${j.error ? ` ${j.error}` : ""})`);
  return { accessToken: String(j.access_token), refreshToken: j.refresh_token ? String(j.refresh_token) : undefined, expiresAt: j.expires_in ? Date.now() + Number(j.expires_in) * 1000 : undefined };
}

/** quotaExceeded / uploadLimitExceeded : quota ; le reste suit la correspondance commune. */
const reason = (j: any) => String(j?.error?.errors?.[0]?.reason ?? j?.error?.status ?? "");

export const youtube: Provider = {
  id: "youtube", label: "YouTube", env: ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET"],
  limits: { text: 5000, media: 1 },
  configured: () => !!env().id && !!env().secret,
  check: ({ title, media, visibility }) => [
    ...(media.length !== 1 || !media[0].mime.startsWith("video/") ? ["YouTube : une seule vidéo"] : []),
    ...((title ?? "").length > 100 ? ["YouTube : titre de 100 caractères au plus"] : []),
    ...(visibility && !["public", "unlisted", "private"].includes(visibility) ? [`YouTube : confidentialité inconnue (${visibility})`] : []),
  ],
  authUrl: (redirectUri, state, verifier) => `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
    client_id: env().id, redirect_uri: redirectUri, response_type: "code", scope: SCOPES.join(" "), state,
    access_type: "offline", prompt: "consent", code_challenge: challenge(verifier), code_challenge_method: "S256",
  })}`,
  async exchange(code, redirectUri, verifier) {
    const t = await token({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier });
    const r = await f("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", { headers: { Authorization: `Bearer ${t.accessToken}` } });
    const items: any[] = (await json(r)).items ?? [];
    if (!r.ok || !items.length) throw new Error("Aucune chaîne YouTube sur ce compte Google");
    return items.map((c): Tokens => ({ ...t, accountId: String(c.id), name: String(c.snippet?.title ?? "YouTube") }));
  },
  refresh: (refreshToken) => token({ grant_type: "refresh_token", refresh_token: refreshToken }),

  async publish({ text, title, visibility, media }, t) {
    const video = media[0];
    let session: string;
    try {
      const r = await f("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
        method: "POST",
        headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Length": String(video.size), "X-Upload-Content-Type": video.mime },
        body: JSON.stringify({ snippet: { title: (title || text).slice(0, 100), description: text }, status: { privacyStatus: visibility || "public", selfDeclaredMadeForKids: false } }),
      });
      if (!r.ok || !r.headers.get("location")) {
        const j = await json(r), why = reason(j);
        if (why === "quotaExceeded" || why === "uploadLimitExceeded") return fail("quota", `YouTube : quota atteint (${why})`);
        return before("YouTube", r.status, why);
      }
      session = String(r.headers.get("location"));
    } catch (e) { return fail("network", `YouTube : ouverture de l'envoi impossible (${(e as Error).message})`); }
    // Le PUT crée la vidéo : un doute à ce stade est « à vérifier ».
    let r: Response;
    try { r = await f(session, { method: "PUT", headers: { "Content-Type": video.mime, "Content-Length": String(video.size) }, body: new Uint8Array(video.bytes()) }); }
    catch (e) { return unknown("YouTube", e); }
    const j = await json(r);
    return r.ok && j.id ? { ok: true, url: `https://www.youtube.com/watch?v=${j.id}` } : final("YouTube", r.status, reason(j));
  },
};

registerProvider(youtube);
