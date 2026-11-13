// SPDX-License-Identifier: AGPL-3.0-only
// Facebook (Pages) et Instagram (comptes professionnels) : une seule application Meta, deux fournisseurs.
// Dérivé en partie de Postiz (facebook.provider.ts, instagram.provider.ts), Copyright (C) 2025 Nevo David,
// https://github.com/gitroomhq/postiz-app — réécrit sans NestJS ni Temporal ; publication en deux temps par `poll` ;
// un media_publish incertain renvoie to_verify (Instagram peut publier malgré une erreur).
import { registerProvider, type Media, type Provider, type PublishResult, type Tokens } from "../provider.ts";
import { before, blob, f, fail, final, json, pending, unknown } from "./http.ts";

export const GRAPH = "https://graph.facebook.com/v25.0";
const VIDEO = "https://graph-video.facebook.com/v25.0";
const env = () => ({ id: process.env.FACEBOOK_CLIENT_ID ?? "", secret: process.env.FACEBOOK_CLIENT_SECRET ?? "" });

/** Erreur Graph : code 190 = jeton, 4/17/32/613 = débit, 368 = refus, sinon format. */
function metaError(net: string, status: number, body: any, isFinal: boolean): PublishResult {
  const e = body?.error ?? {}, msg = String(e.message ?? "").slice(0, 200);
  if (e.code === 190 || status === 401) return fail("auth", `${net} : jeton refusé, reconnectez le compte`);
  if ([4, 17, 32, 613].includes(Number(e.code)) || status === 429) return fail("rate", `${net} : limite de débit atteinte`);
  if (e.code === 368) return fail("refused", `${net} a refusé la publication : ${msg}`);
  return (isFinal ? final : before)(net, status, msg);
}

async function userToken(code: string, redirectUri: string) {
  const { id, secret } = env();
  const a = await f(`${GRAPH}/oauth/access_token?${new URLSearchParams({ client_id: id, client_secret: secret, redirect_uri: redirectUri, code })}`);
  const short = await json(a);
  if (!a.ok || !short.access_token) throw new Error(`Meta a refusé l'autorisation (${a.status})`);
  // Jeton long (60 jours) : les jetons de Page qui en dérivent n'expirent pas.
  const b = await f(`${GRAPH}/oauth/access_token?${new URLSearchParams({ grant_type: "fb_exchange_token", client_id: id, client_secret: secret, fb_exchange_token: short.access_token })}`);
  const long = await json(b);
  return String(long.access_token ?? short.access_token);
}

async function pages(token: string, fields: string): Promise<any[]> {
  const r = await f(`${GRAPH}/me/accounts?${new URLSearchParams({ fields, limit: "100", access_token: token })}`);
  const j = await json(r);
  if (!r.ok) throw new Error(`Pages Meta illisibles (${r.status})`);
  return j.data ?? [];
}

const authUrl = (scopes: string[]) => (redirectUri: string, state: string) =>
  `https://www.facebook.com/v25.0/dialog/oauth?${new URLSearchParams({ client_id: env().id, redirect_uri: redirectUri, state, scope: scopes.join(","), response_type: "code" })}`;

const post = (url: string, body: FormData | URLSearchParams) => f(url, { method: "POST", body });

// ── Facebook ──
export const facebook: Provider = {
  id: "facebook", label: "Facebook", env: ["FACEBOOK_CLIENT_ID", "FACEBOOK_CLIENT_SECRET"],
  limits: { text: 63_206, media: 10 },
  configured: () => !!env().id && !!env().secret,
  check: ({ media }) => media.some((m) => m.mime.startsWith("video/")) && media.length > 1 ? ["Facebook : une vidéo seule, ou des images"] : [],
  authUrl: authUrl(["pages_show_list", "pages_manage_posts", "pages_read_engagement"]),
  async exchange(code, redirectUri) {
    const list = await pages(await userToken(code, redirectUri), "id,name,access_token");
    if (!list.length) throw new Error("Aucune Page Facebook administrée par ce compte");
    return list.map((p): Tokens => ({ accessToken: p.access_token, accountId: String(p.id), name: String(p.name) }));
  },

  async publish({ text, media }, token, page) {
    try {
      const video = media.find((m) => m.kind === "video");
      if (video) {
        const fd = new FormData();
        fd.append("access_token", token); fd.append("description", text); fd.append("source", blob(video.bytes(), video.mime), "video");
        let r: Response;
        try { r = await post(`${VIDEO}/${page}/videos`, fd); } catch (e) { return unknown("Facebook", e); }
        const j = await json(r);
        return r.ok && j.id ? { ok: true, url: `https://www.facebook.com/${page}/videos/${j.id}` } : metaError("Facebook", r.status, j, true);
      }
      // Photos envoyées non publiées, puis un seul post qui les rassemble : rien n'est visible avant le geste final.
      const ids: string[] = [];
      for (const m of media) {
        const fd = new FormData();
        fd.append("access_token", token); fd.append("published", "false"); fd.append("source", blob(m.bytes(), m.mime), "image");
        const r = await post(`${GRAPH}/${page}/photos`, fd), j = await json(r);
        if (!r.ok || !j.id) return metaError("Facebook", r.status, j, false);
        ids.push(String(j.id));
      }
      const body = new URLSearchParams({ access_token: token, message: text });
      ids.forEach((id, i) => body.append(`attached_media[${i}]`, JSON.stringify({ media_fbid: id })));
      let r: Response;
      try { r = await post(`${GRAPH}/${page}/feed`, body); } catch (e) { return unknown("Facebook", e); }
      const j = await json(r);
      return r.ok && j.id ? { ok: true, url: `https://www.facebook.com/${j.id}` } : metaError("Facebook", r.status, j, true);
    } catch (e) { return fail("network", `Facebook : envoi du média impossible (${(e as Error).message})`); }
  },
};

// ── Instagram ──
const container = async (ig: string, token: string, fields: Record<string, string>) => {
  const r = await post(`${GRAPH}/${ig}/media`, new URLSearchParams({ ...fields, access_token: token }));
  return { r, j: await json(r) };
};
const itemFields = (m: Media, carousel: boolean): Record<string, string> => m.kind === "video"
  ? { media_type: carousel ? "VIDEO" : "REELS", video_url: m.publicUrl(), ...(carousel ? { is_carousel_item: "true" } : {}) }
  : { image_url: m.publicUrl(), ...(carousel ? { is_carousel_item: "true" } : {}) };

async function status(id: string, token: string): Promise<string> {
  const r = await f(`${GRAPH}/${id}?${new URLSearchParams({ fields: "status_code", access_token: token })}`);
  return String((await json(r)).status_code ?? (r.ok ? "IN_PROGRESS" : "UNREADABLE"));
}

export const instagram: Provider = {
  id: "instagram", label: "Instagram", env: ["FACEBOOK_CLIENT_ID", "FACEBOOK_CLIENT_SECRET"],
  limits: { text: 2200, media: 10 }, needsPublicMedia: true,
  configured: () => !!env().id && !!env().secret,
  check: ({ media }) => media.length ? [] : ["Instagram : au moins une image ou une vidéo"],
  authUrl: authUrl(["instagram_basic", "instagram_content_publish", "pages_show_list", "pages_read_engagement", "business_management"]),
  async exchange(code, redirectUri) {
    const list = (await pages(await userToken(code, redirectUri), "id,name,access_token,instagram_business_account{id,username}")).filter((p) => p.instagram_business_account?.id);
    if (!list.length) throw new Error("Aucun compte Instagram professionnel relié à une Page de ce compte");
    return list.map((p): Tokens => ({ accessToken: p.access_token, accountId: String(p.instagram_business_account.id), name: `@${p.instagram_business_account.username ?? p.name}` }));
  },

  async publish({ text, media }, token, ig) {
    try {
      if (media.length === 1) {
        const { r, j } = await container(ig, token, { ...itemFields(media[0], false), caption: text });
        return r.ok && j.id ? pending("Instagram traite le média", { stage: "container", id: String(j.id) }) : metaError("Instagram", r.status, j, false);
      }
      const children: string[] = [];
      for (const m of media) {
        const { r, j } = await container(ig, token, itemFields(m, true));
        if (!r.ok || !j.id) return metaError("Instagram", r.status, j, false);
        children.push(String(j.id));
      }
      return pending("Instagram traite le carrousel", { stage: "children", children, caption: text });
    } catch (e) { return fail("network", `Instagram : création du conteneur impossible (${(e as Error).message})`); }
  },

  async poll(data, token, ig) {
    // Conteneurs invisibles tant que media_publish n'a pas eu lieu : relire leur état est sans risque.
    try {
      if (data.stage === "children") {
        const states = await Promise.all((data.children as string[]).map((id) => status(id, token)));
        if (states.some((s) => s === "ERROR" || s === "EXPIRED")) return fail("format", "Instagram a refusé un média du carrousel");
        if (!states.every((s) => s === "FINISHED")) return pending("Instagram traite le carrousel", data);
        const { r, j } = await container(ig, token, { media_type: "CAROUSEL", children: (data.children as string[]).join(","), caption: String(data.caption ?? "") });
        return r.ok && j.id ? pending("Instagram prépare le carrousel", { stage: "container", id: String(j.id) }) : metaError("Instagram", r.status, j, false);
      }
      const s = await status(String(data.id), token);
      if (s === "ERROR" || s === "EXPIRED") return fail("format", `Instagram a refusé le média (${s})`);
      if (s !== "FINISHED") return pending("Instagram traite le média", data);
    } catch { return pending("Instagram ne répond pas, nouvelle lecture plus tard", data); }

    let r: Response;
    try { r = await post(`${GRAPH}/${ig}/media_publish`, new URLSearchParams({ creation_id: String(data.id), access_token: token })); }
    catch (e) { return unknown("Instagram", e); }
    const j = await json(r);
    if (!r.ok || !j.id) return fail("to_verify", `Instagram : publication incertaine (${r.status}), vérifiez sur le réseau`);
    try {
      const p = await json(await f(`${GRAPH}/${j.id}?${new URLSearchParams({ fields: "permalink", access_token: token })}`));
      if (p.permalink) return { ok: true, url: String(p.permalink) };
    } catch { /* lien facultatif */ }
    return { ok: true, url: `https://www.instagram.com/` };
  },
};

registerProvider(facebook);
registerProvider(instagram);
