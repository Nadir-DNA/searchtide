// SPDX-License-Identifier: AGPL-3.0-only
// Fournisseur Reddit : OAuth « permanent » (jeton renouvelable), un post texte ou lien dans le subreddit réglé sur le
// compte, commentaires sous un post. Reddit exige un User-Agent identifiable. Médias : non pris en charge par l'API.
// Écrit pour Searchtide sur le modèle des fournisseurs Postiz (reddit.provider.ts), Copyright (C) 2025 Nevo David,
// https://github.com/gitroomhq/postiz-app.
import { registerProvider, type Provider, type PublishResult } from "../provider.ts";
import { f, fail, final, json, n, unknown } from "./http.ts";

const API = "https://oauth.reddit.com";
const SCOPES = ["identity", "submit", "read"];
const env = () => ({ id: process.env.REDDIT_CLIENT_ID ?? "", secret: process.env.REDDIT_CLIENT_SECRET ?? "" });
const UA = "web:searchtide:1.0 (auto-hebergé)";
const headers = (t: string) => ({ Authorization: `Bearer ${t}`, "User-Agent": UA });

async function token(body: Record<string, string>) {
  const { id, secret } = env();
  const r = await f("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA, Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}` },
    body: new URLSearchParams(body),
  });
  const j = await json(r);
  if (!r.ok || !j.access_token) throw new Error(`Reddit a refusé l'autorisation (${r.status}${j.error ? ` ${j.error}` : ""})`);
  return { accessToken: String(j.access_token), refreshToken: j.refresh_token ? String(j.refresh_token) : undefined, expiresAt: j.expires_in ? Date.now() + Number(j.expires_in) * 1000 : undefined };
}

/** Identifiant d'un post dans son adresse (…/comments/abc123/…). */
export const postId = (url: string) => /\/comments\/([a-z0-9]+)/i.exec(url)?.[1];
/** Un texte réduit à une seule adresse devient un post « lien ». */
const onlyLink = (text: string) => /^\s*(https?:\/\/\S+)\s*$/.exec(text)?.[1];
const SUB = /^[A-Za-z0-9_]{3,21}$/;

/** Erreurs Reddit renvoyées en 200 : [["RATELIMIT", "message", "champ"], …]. */
function errors(j: any, net: string): PublishResult | null {
  const list: any[] = j?.json?.errors ?? [];
  if (!list.length) return null;
  const [code, msg] = list[0];
  if (code === "RATELIMIT") return fail("rate", `${net} : ${msg ?? "patientez avant de publier à nouveau"}`);
  if (code === "USER_REQUIRED" || code === "INVALID_CREDENTIALS") return fail("auth", `${net} : reconnectez le compte`);
  return fail("format", `${net} a refusé le post : ${code}${msg ? ` (${msg})` : ""}`);
}

export const reddit: Provider = {
  id: "reddit", label: "Reddit", env: ["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET"],
  limits: { text: 40_000, media: 0 },
  configured: () => !!env().id && !!env().secret,
  target: { label: "Subreddit", help: "Nom du subreddit sans « r/ » (ex. entrepreneur). Lisez ses règles : beaucoup refusent les liens ou l'autopromotion.", pattern: SUB },
  check: ({ title }) => [
    ...(!(title ?? "").trim() ? ["Reddit : titre requis"] : []),
    ...((title ?? "").length > 300 ? ["Reddit : titre de 300 caractères au plus"] : []),
  ],
  authUrl: (redirectUri, state) => `https://www.reddit.com/api/v1/authorize?${new URLSearchParams({
    client_id: env().id, response_type: "code", state, redirect_uri: redirectUri, duration: "permanent", scope: SCOPES.join(" "),
  })}`,
  async exchange(code, redirectUri) {
    const t = await token({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
    const r = await f(`${API}/api/v1/me`, { headers: headers(t.accessToken) });
    const me = await json(r);
    if (!r.ok || !me.name) throw new Error(`Profil Reddit illisible (${r.status})`);
    return [{ ...t, accountId: String(me.name), name: `u/${me.name}` }];
  },
  refresh: (refreshToken) => token({ grant_type: "refresh_token", refresh_token: refreshToken }),
  // Abonnés au profil (le subreddit personnel de l'utilisateur) ; karma total en guise de « vues » n'aurait pas de sens.
  async stats(t) {
    const r = await f(`${API}/api/v1/me`, { headers: headers(t) });
    const j = await json(r);
    if (!r.ok) throw new Error(`Reddit : profil illisible (${r.status})`);
    return { followers: n(j.subreddit?.subscribers) };
  },
  async postStats(urls, t) {
    const ids = new Map(urls.flatMap((u) => { const id = postId(u); return id ? [[`t3_${id}`, u] as [string, string]] : []; }));
    if (!ids.size) return {};
    const r = await f(`${API}/api/info?id=${[...ids.keys()].join(",")}`, { headers: headers(t) });
    if (!r.ok) throw new Error(`Reddit : statistiques refusées (${r.status})`);
    const out: Record<string, { likes?: number; comments?: number }> = {};
    for (const c of (await json(r)).data?.children ?? []) {
      const u = ids.get(String(c.data?.name)); if (u) out[u] = { likes: n(c.data?.score), comments: n(c.data?.num_comments) };
    }
    return out;
  },

  async publish({ text, title, target }, t) {
    if (!target || !SUB.test(target)) return fail("format", "Reddit : réglez le subreddit du compte");
    const link = onlyLink(text);
    const body = new URLSearchParams({ api_type: "json", sr: target, title: String(title ?? "").slice(0, 300), kind: link ? "link" : "self", ...(link ? { url: link } : { text }), resubmit: "true" });
    let r: Response;
    try { r = await f(`${API}/api/submit`, { method: "POST", headers: { ...headers(t), "Content-Type": "application/x-www-form-urlencoded" }, body }); }
    catch (e) { return unknown("Reddit", e); }
    const j = await json(r);
    if (r.ok) {
      const e = errors(j, "Reddit"); if (e) return e;
      const url = j.json?.data?.url;
      return url ? { ok: true, url: String(url) } : fail("to_verify", "Reddit : réponse sans adresse, vérifiez sur le subreddit");
    }
    return final("Reddit", r.status);
  },
  async reply(parentUrl, text, t) {
    const id = postId(parentUrl);
    if (!id) return fail("format", "Reddit : adresse du post illisible");
    let r: Response;
    try { r = await f(`${API}/api/comment`, { method: "POST", headers: { ...headers(t), "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ api_type: "json", thing_id: `t3_${id}`, text }) }); }
    catch (e) { return unknown("Reddit", e); }
    const j = await json(r);
    if (!r.ok) return final("Reddit", r.status);
    const e = errors(j, "Reddit"); if (e) return e;
    const c = j.json?.data?.things?.[0]?.data;
    return c?.permalink ? { ok: true, url: `https://www.reddit.com${c.permalink}` } : { ok: true, url: parentUrl };
  },
};

registerProvider(reddit);
