// SPDX-License-Identifier: AGPL-3.0-only
// Fournisseur Pinterest (API v5) : OAuth, une épingle par publication sur un tableau. Chaque tableau du compte devient
// un compte de publication. Image envoyée en base64 (pas besoin d'adresse publique), lien repris du texte.
// Écrit pour Searchtide sur le modèle des fournisseurs Postiz (pinterest.provider.ts), Copyright (C) 2025 Nevo David,
// https://github.com/gitroomhq/postiz-app.
import { registerProvider, type Provider, type Tokens } from "../provider.ts";
import { before, f, fail, final, json, n, unknown } from "./http.ts";

const API = "https://api.pinterest.com/v5";
const SCOPES = ["boards:read", "pins:read", "pins:write", "user_accounts:read"];
const env = () => ({ id: process.env.PINTEREST_CLIENT_ID ?? "", secret: process.env.PINTEREST_CLIENT_SECRET ?? "" });
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

async function token(body: Record<string, string>) {
  const { id, secret } = env();
  const r = await f(`${API}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}` },
    body: new URLSearchParams(body),
  });
  const j = await json(r);
  if (!r.ok || !j.access_token) throw new Error(`Pinterest a refusé l'autorisation (${r.status}${j.message ? ` ${j.message}` : ""})`);
  return { accessToken: String(j.access_token), refreshToken: j.refresh_token ? String(j.refresh_token) : undefined, expiresAt: j.expires_in ? Date.now() + Number(j.expires_in) * 1000 : undefined };
}

/** Premier lien du texte : l'épingle y renvoie. */
export const firstLink = (text: string) => /https?:\/\/[^\s)]+/.exec(text)?.[0];
/** Identifiant d'épingle dans son adresse (https://www.pinterest.com/pin/123/). */
const pinId = (url: string) => /\/pin\/(\d+)/.exec(url)?.[1];
const day = (d: Date) => d.toISOString().slice(0, 10);

export const pinterest: Provider = {
  id: "pinterest", label: "Pinterest", env: ["PINTEREST_CLIENT_ID", "PINTEREST_CLIENT_SECRET"],
  limits: { text: 800, media: 1 },
  configured: () => !!env().id && !!env().secret,
  check: ({ media, title }) => [
    ...(media.length !== 1 || !media[0].mime.startsWith("image/") ? ["Pinterest : une image par épingle"] : []),
    ...((title ?? "").length > 100 ? ["Pinterest : titre de 100 caractères au plus"] : []),
    ...(media.some((m) => m.size > 20 * 1024 * 1024) ? ["Pinterest : image de plus de 20 Mo"] : []),
  ],
  authUrl: (redirectUri, state) => `https://www.pinterest.com/oauth/?${new URLSearchParams({
    client_id: env().id, redirect_uri: redirectUri, response_type: "code", scope: SCOPES.join(","), state,
  })}`,
  async exchange(code, redirectUri) {
    const t = await token({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
    const me = await json(await f(`${API}/user_account`, { headers: bearer(t.accessToken) }));
    const r = await f(`${API}/boards?page_size=100`, { headers: bearer(t.accessToken) });
    const boards: any[] = (await json(r)).items ?? [];
    if (!r.ok || !boards.length) throw new Error("Aucun tableau Pinterest sur ce compte : créez-en un, puis reconnectez");
    const who = me.username ? `@${me.username}` : "Pinterest";
    return boards.map((b): Tokens => ({ ...t, accountId: String(b.id), name: `${who} · ${b.name ?? "tableau"}` }));
  },
  refresh: (refreshToken) => token({ grant_type: "refresh_token", refresh_token: refreshToken }),
  async stats(t) {
    const r = await f(`${API}/user_account`, { headers: bearer(t) });
    const j = await json(r);
    if (!r.ok) throw new Error(`Pinterest : statistiques refusées (${r.status})`);
    return { followers: n(j.follower_count), posts: n(j.pin_count), views: n(j.monthly_views) };
  },
  // Impressions et enregistrements (comptés comme partages) des 30 derniers jours, épingle par épingle.
  async postStats(urls, t) {
    const out: Record<string, { impressions?: number; shares?: number; views?: number }> = {};
    const end = new Date(), start = new Date(Date.now() - 30 * 86_400_000);
    for (const u of urls) {
      const id = pinId(u); if (!id) continue;
      const r = await f(`${API}/pins/${id}/analytics?${new URLSearchParams({ start_date: day(start), end_date: day(end), metric_types: "IMPRESSION,SAVE,PIN_CLICK" })}`, { headers: bearer(t) });
      if (!r.ok) continue;
      const m = (await json(r)).all?.summary_metrics ?? {};
      out[u] = { impressions: n(m.IMPRESSION), shares: n(m.SAVE), views: n(m.PIN_CLICK) };
    }
    return out;
  },

  async publish({ text, title, media }, t, boardId) {
    const img = media[0];
    const link = firstLink(text);
    let r: Response;
    try {
      r = await f(`${API}/pins`, {
        method: "POST", headers: { ...bearer(t), "Content-Type": "application/json" },
        body: JSON.stringify({
          board_id: boardId, title: (title ?? "").slice(0, 100) || undefined, description: text.slice(0, 800), ...(link ? { link } : {}),
          media_source: { source_type: "image_base64", content_type: img.mime, data: img.bytes().toString("base64") },
        }),
      });
    } catch (e) { return unknown("Pinterest", e); }
    const j = await json(r);
    if (r.ok && j.id) return { ok: true, url: `https://www.pinterest.com/pin/${j.id}/` };
    if (r.status === 429) return fail("rate", "Pinterest : limite de débit atteinte");
    if (r.status === 403) return fail("refused", `Pinterest a refusé l'épingle : ${String(j.message ?? "accès insuffisant (application en accès d'essai ?)").slice(0, 200)}`);
    return r.status >= 500 ? final("Pinterest", r.status) : before("Pinterest", r.status, String(j.message ?? "").slice(0, 200));
  },
};

registerProvider(pinterest);
