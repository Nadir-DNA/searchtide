// SPDX-License-Identifier: AGPL-3.0-only
// Fournisseur Google Business Profile : OAuth Google (business.manage), une « actualité » par publication sur une fiche.
// Chaque fiche (établissement) du compte devient un compte de publication. L'accès à ces API se demande à Google
// (formulaire « Business Profile API ») : sans validation, Google répond 403 ou des quotas à zéro.
import { registerProvider, type Provider, type Tokens } from "../provider.ts";
import { challenge, f, fail, final, json, n, unknown } from "./http.ts";
import { firstLink } from "./pinterest.ts";

const SCOPES = ["https://www.googleapis.com/auth/business.manage"];
const env = () => ({ id: process.env.GOOGLE_BUSINESS_CLIENT_ID ?? "", secret: process.env.GOOGLE_BUSINESS_CLIENT_SECRET ?? "" });
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

async function token(body: Record<string, string>) {
  const { id, secret } = env();
  const r = await f("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...body, client_id: id, client_secret: secret }) });
  const j = await json(r);
  if (!r.ok || !j.access_token) throw new Error(`Google a refusé l'autorisation (${r.status}${j.error ? ` ${j.error}` : ""})`);
  return { accessToken: String(j.access_token), refreshToken: j.refresh_token ? String(j.refresh_token) : undefined, expiresAt: j.expires_in ? Date.now() + Number(j.expires_in) * 1000 : undefined };
}

const IMPRESSIONS = ["BUSINESS_IMPRESSIONS_DESKTOP_MAPS", "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH", "BUSINESS_IMPRESSIONS_MOBILE_MAPS", "BUSINESS_IMPRESSIONS_MOBILE_SEARCH"];
const ymd = (d: Date, k: string) => ({ [`dailyRange.${k}_date.year`]: String(d.getUTCFullYear()), [`dailyRange.${k}_date.month`]: String(d.getUTCMonth() + 1), [`dailyRange.${k}_date.day`]: String(d.getUTCDate()) });

export const gbp: Provider = {
  id: "gbp", label: "Google Business Profile", env: ["GOOGLE_BUSINESS_CLIENT_ID", "GOOGLE_BUSINESS_CLIENT_SECRET"],
  limits: { text: 1500, media: 1 },
  needsPublicMedia: true,
  configured: () => !!env().id && !!env().secret,
  check: ({ media }) => media.some((m) => !m.mime.startsWith("image/")) ? ["Google Business Profile : une image (pas de vidéo par l'API)"] : [],
  authUrl: (redirectUri, state, verifier) => `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
    client_id: env().id, redirect_uri: redirectUri, response_type: "code", scope: SCOPES.join(" "), state,
    access_type: "offline", prompt: "consent", code_challenge: challenge(verifier), code_challenge_method: "S256",
  })}`,
  async exchange(code, redirectUri, verifier) {
    const t = await token({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier });
    const ar = await f("https://mybusinessaccountmanagement.googleapis.com/v1/accounts", { headers: bearer(t.accessToken) });
    if (ar.status === 403 || ar.status === 429) throw new Error("Google refuse l'accès aux API Business Profile : demandez l'accès (formulaire « Business Profile API ») pour votre projet Google Cloud");
    const accounts: any[] = (await json(ar)).accounts ?? [];
    const out: Tokens[] = [];
    for (const a of accounts) {
      const lr = await f(`https://mybusinessbusinessinformation.googleapis.com/v1/${a.name}/locations?readMask=name,title&pageSize=100`, { headers: bearer(t.accessToken) });
      for (const l of (await json(lr)).locations ?? []) out.push({ ...t, accountId: `${a.name}/${l.name}`, name: String(l.title ?? "Fiche Google") });
    }
    if (!out.length) throw new Error("Aucune fiche d'établissement sur ce compte Google");
    return out;
  },
  refresh: (refreshToken) => token({ grant_type: "refresh_token", refresh_token: refreshToken }),
  // Vues de la fiche sur 28 jours (recherche et Maps, ordinateur et mobile). Pas d'abonnés sur une fiche.
  async stats(t, id) {
    const location = id.slice(id.indexOf("locations/"));
    const end = new Date(Date.now() - 2 * 86_400_000), start = new Date(end.getTime() - 27 * 86_400_000);
    const q = new URLSearchParams({ ...ymd(start, "start"), ...ymd(end, "end") });
    for (const m of IMPRESSIONS) q.append("dailyMetrics", m);
    const r = await f(`https://businessprofileperformance.googleapis.com/v1/${location}:fetchMultiDailyMetricsTimeSeries?${q}`, { headers: bearer(t) });
    const j = await json(r);
    if (!r.ok) throw new Error(`Google Business Profile : statistiques refusées (${r.status})`);
    let views: number | undefined;
    for (const s of j.multiDailyMetricTimeSeries ?? []) for (const d of s.dailyMetricTimeSeries ?? []) for (const v of d.timeSeries?.datedValues ?? []) {
      const x = n(v.value); if (x != null) views = (views ?? 0) + x;
    }
    return { views };
  },

  async publish({ text, media }, t, id) {
    const link = firstLink(text);
    let r: Response;
    try {
      r = await f(`https://mybusiness.googleapis.com/v4/${id}/localPosts`, {
        method: "POST", headers: { ...bearer(t), "Content-Type": "application/json" },
        body: JSON.stringify({
          languageCode: "fr", topicType: "STANDARD", summary: text.slice(0, 1500),
          ...(link ? { callToAction: { actionType: "LEARN_MORE", url: link } } : {}),
          ...(media.length ? { media: [{ mediaFormat: "PHOTO", sourceUrl: media[0].publicUrl() }] } : {}),
        }),
      });
    } catch (e) { return unknown("Google Business Profile", e); }
    const j = await json(r);
    if (r.ok && (j.searchUrl || j.name)) return { ok: true, url: String(j.searchUrl ?? `https://business.google.com/posts/${j.name}`) };
    if (r.status === 403) return fail("refused", "Google Business Profile : accès refusé (API à demander à Google, ou fiche non validée)");
    if (r.status === 429) return fail("quota", "Google Business Profile : quota atteint");
    return final("Google Business Profile", r.status, String(j.error?.message ?? "").slice(0, 200));
  },
};

registerProvider(gbp);
