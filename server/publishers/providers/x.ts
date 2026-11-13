// SPDX-License-Identifier: AGPL-3.0-only
// Fournisseur X : OAuth 2.0 PKCE, envoi des médias par morceaux (API v2), vidéo traitée en deux temps.
// Envoi par morceaux d'après Postiz (x.provider.ts), Copyright (C) 2025 Nevo David, https://github.com/gitroomhq/postiz-app ;
// réécrit en OAuth 2.0 sans dépendance ; un post incertain renvoie to_verify.
import { registerProvider, type Media, type Provider, type PublishResult, type Tokens } from "../provider.ts";
import { before, blob, challenge, f, fail, final, json, pending, unknown } from "./http.ts";

const API = "https://api.x.com/2";
const CHUNK = 1024 * 1024;
const SCOPES = ["tweet.read", "tweet.write", "users.read", "offline.access", "media.write"];
const env = () => ({ id: process.env.X_CLIENT_ID ?? "", secret: process.env.X_CLIENT_SECRET ?? "" });
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

async function token(body: Record<string, string>) {
  const { id, secret } = env();
  const r = await f(`${API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}` },
    body: new URLSearchParams({ ...body, client_id: id }),
  });
  const j = await json(r);
  if (!r.ok || !j.access_token) throw new Error(`X a refusé l'autorisation (${r.status}${j.error ? ` ${j.error}` : ""})`);
  return { accessToken: String(j.access_token), refreshToken: j.refresh_token ? String(j.refresh_token) : undefined, expiresAt: j.expires_in ? Date.now() + Number(j.expires_in) * 1000 : undefined };
}

const category = (m: Media) => m.kind === "video" ? "tweet_video" : m.mime === "image/gif" ? "tweet_gif" : "tweet_image";

/** Envoie un média ; renvoie son identifiant et s'il est encore en traitement. Rien n'est publié à ce stade. */
async function upload(m: Media, t: string): Promise<{ id: string; processing: boolean } | PublishResult> {
  const init = await f(`${API}/media/upload/initialize`, { method: "POST", headers: { ...bearer(t), "Content-Type": "application/json" }, body: JSON.stringify({ media_type: m.mime, total_bytes: m.size, media_category: category(m) }) });
  const ij = await json(init);
  if (!init.ok || !ij.data?.id) return before("X", init.status, ij.detail ?? "");
  const id = String(ij.data.id), bytes = m.bytes();
  for (let i = 0; i * CHUNK < bytes.length; i++) {
    const fd = new FormData();
    fd.append("segment_index", String(i)); fd.append("media", blob(bytes.subarray(i * CHUNK, (i + 1) * CHUNK), m.mime), "media");
    const a = await f(`${API}/media/upload/${id}/append`, { method: "POST", headers: bearer(t), body: fd });
    if (!a.ok) return before("X", a.status);
  }
  const fin = await f(`${API}/media/upload/${id}/finalize`, { method: "POST", headers: bearer(t) });
  const fj = await json(fin);
  if (!fin.ok) return before("X", fin.status, fj.detail ?? "");
  const state = fj.data?.processing_info?.state;
  if (state === "failed") return fail("format", "X n'a pas pu traiter le média");
  return { id, processing: !!state && state !== "succeeded" };
}

async function tweet(text: string, mediaIds: string[], t: string): Promise<PublishResult> {
  let r: Response;
  try {
    r = await f(`${API}/tweets`, { method: "POST", headers: { ...bearer(t), "Content-Type": "application/json" }, body: JSON.stringify({ text, ...(mediaIds.length ? { media: { media_ids: mediaIds } } : {}) }) });
  } catch (e) { return unknown("X", e); }
  const j = await json(r);
  if (r.ok && j.data?.id) return { ok: true, url: `https://x.com/i/status/${j.data.id}` };
  if (r.status === 403) return fail("refused", `X a refusé le post : ${String(j.detail ?? "contenu non autorisé ou en double").slice(0, 200)}`);
  return final("X", r.status, String(j.detail ?? "").slice(0, 200));
}

export const x: Provider = {
  id: "x", label: "X", env: ["X_CLIENT_ID", "X_CLIENT_SECRET"],
  limits: { text: 280, media: 4 },
  configured: () => !!env().id && !!env().secret,
  check: ({ media }) => media.some((m) => m.mime.startsWith("video/")) && media.length > 1 ? ["X : une vidéo seule, ou jusqu'à 4 images"] : [],
  authUrl: (redirectUri, state, verifier) => `https://x.com/i/oauth2/authorize?${new URLSearchParams({
    response_type: "code", client_id: env().id, redirect_uri: redirectUri, scope: SCOPES.join(" "), state,
    code_challenge: challenge(verifier), code_challenge_method: "S256",
  })}`,
  async exchange(code, redirectUri, verifier) {
    const t = await token({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier });
    const r = await f(`${API}/users/me`, { headers: bearer(t.accessToken) });
    const me = (await json(r)).data;
    if (!r.ok || !me?.id) throw new Error(`Profil X illisible (${r.status})`);
    return [{ ...t, accountId: String(me.id), name: `@${me.username ?? me.name}` } satisfies Tokens];
  },
  refresh: (refreshToken) => token({ grant_type: "refresh_token", refresh_token: refreshToken }),

  async publish({ text, media }, t) {
    const ids: string[] = [], waiting: string[] = [];
    try {
      for (const m of media) {
        const u = await upload(m, t);
        if ("ok" in u) return u;
        ids.push(u.id); if (u.processing) waiting.push(u.id);
      }
    } catch (e) { return fail("network", `X : envoi du média impossible (${(e as Error).message})`); }
    return waiting.length ? pending("X traite la vidéo", { text, ids, waiting }) : tweet(text, ids, t);
  },

  async poll(data, t) {
    const waiting: string[] = [];
    try {
      for (const id of data.waiting as string[]) {
        const r = await f(`${API}/media/upload?${new URLSearchParams({ command: "STATUS", media_id: id })}`, { headers: bearer(t) });
        const state = (await json(r)).data?.processing_info?.state;
        if (state === "failed") return fail("format", "X n'a pas pu traiter la vidéo");
        if (state && state !== "succeeded") waiting.push(id);
      }
    } catch { return pending("X ne répond pas, nouvelle lecture plus tard", data); }
    return waiting.length ? pending("X traite la vidéo", { ...data, waiting }) : tweet(String(data.text ?? ""), data.ids as string[], t);
  },
};

registerProvider(x);
