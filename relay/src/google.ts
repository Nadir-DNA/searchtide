// Routes Google Agenda du relais Searchtide Connect : le relais détient le secret de l'application Google (vérifiée), les instances non.
// Il ne lit jamais l'agenda : il échange le code d'autorisation, remet le jeton de renouvellement à l'instance (une seule fois, chiffré
// quelques instants), puis ne fait que transformer ce jeton en jeton d'accès de courte durée. Aucun jeton Google n'est conservé.
// Routes : /v1/google/start, /google/authorize, /google/go, /google/callback, /v1/google/token, /v1/google/refresh, /v1/google/revoke.
import { sha256, type Store } from "./store.ts";

export type GoogleEnv = { GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string; STATE_SECRET?: string; RATE_SECRET?: string };
export type GoogleCtx = {
  req: Request; url: URL; env: GoogleEnv; store: Store; now: number; origin: string; fetch: typeof fetch;
  log: (status: number, instanceId?: string | null) => number;
  json: (body: unknown, status?: number, headers?: Record<string, string>) => Response;
  page: (title: string, body: string, status?: number) => Response;
  esc: (s: string) => string; random: (n: number) => string;
  hmac: (text: string, secret: string) => Promise<string>;
  signState: (nonce: string) => Promise<string>; verifyState: (raw: string) => Promise<boolean>;
  same: (a: string, b: string) => boolean; pkce: (verifier: string) => Promise<string>;
};

const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const REVOKE = "https://oauth2.googleapis.com/revoke";
export const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.freebusy"];

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const aesKey = async (secret: string) => crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`gcode:${secret}`)), "AES-GCM", false, ["encrypt", "decrypt"]);
async function seal(secret: string, text: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return `${b64(iv)}.${b64(new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secret), new TextEncoder().encode(text))))}`;
}
async function open(secret: string, blob: string) {
  const [iv, ct] = blob.split(".");
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await aesKey(secret), unb64(ct)));
}

export const googleReady = (e: GoogleEnv) => !!(e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET && e.STATE_SECRET && e.RATE_SECRET);

/** Répond aux routes Google, ou renvoie null si le chemin n'en est pas une. */
export async function handleGoogle(c: GoogleCtx): Promise<Response | null> {
  const { req, url, env, store, now, origin, log, json, page, esc } = c;
  const p = url.pathname;
  if (!p.startsWith("/google/") && !p.startsWith("/v1/google/")) return null;
  if (!googleReady(env)) { log(503); return json({ ok: false, error: "Google Agenda n'est pas configuré sur ce relais" }, 503); }

  const hour = new Date(now).toISOString().slice(0, 13);
  const limit = async (key: string, max: number) => store.rate(`${p}:${key}`, hour, max);
  const ipKey = async () => c.hmac(req.headers.get("cf-connecting-ip") ?? "inconnu", env.RATE_SECRET!);
  const tooMany = () => { log(429); return json({ error: "Trop de demandes" }, 429, { "retry-after": "3600" }); };
  const form = (o: Record<string, string>) => new URLSearchParams(o);
  const call = (url: string, o: Record<string, string>) => c.fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form(o) });

  if (p === "/v1/google/start") {
    if (req.method !== "POST") { log(405); return json({ error: "Méthode non autorisée" }, 405); }
    if (!await limit(await ipKey(), 20)) return tooMany();
    const b = await req.json().catch(() => ({})) as Record<string, string>;
    const instanceId = String(b.instance_id ?? ""), challenge = String(b.code_challenge ?? "");
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(instanceId)) { log(400); return json({ error: "Instance invalide" }, 400); }
    let ret: URL; try { ret = new URL(String(b.return_url ?? "")); } catch { log(400); return json({ error: "URL de retour invalide" }, 400); }
    if (ret.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(ret.hostname)) { log(400); return json({ error: "URL de retour en https requise" }, 400); }
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) { log(400); return json({ error: "PKCE invalide" }, 400); }
    const raw = await c.signState(c.random(16));
    await store.createState(await sha256(raw), { instanceId, host: ret.host, challenge, returnUrl: ret.toString(), expiresAt: now + 10 * 60_000 });
    log(200, instanceId);
    return json({ authorize_url: `${origin}/google/authorize?state=${encodeURIComponent(raw)}` });
  }

  if (p === "/google/authorize" && req.method === "GET") {
    if (!await limit(await ipKey(), 60)) return tooMany();
    const raw = url.searchParams.get("state") ?? "";
    if (!await c.verifyState(raw)) { log(400); return page("Lien invalide", "<h1>Lien invalide</h1><p>Recommencez la connexion depuis votre instance.</p>", 400); }
    const st = await store.getState(await sha256(raw), now);
    if (!st) { log(410); return page("Demande expirée", "<h1>La demande a expiré</h1><p>Recommencez la connexion.</p>", 410); }
    log(200, st.instanceId);
    return page("Autoriser Google Agenda", `<h1>Connecter Google Agenda ?</h1>
      <p>L'instance <strong>${esc(st.host)}</strong> demande à :</p>
      <ul><li>voir vos <strong>occupations</strong> (plages libres ou occupées), pour ne proposer que des créneaux libres ;</li><li>créer et supprimer, dans votre agenda, les <strong>rendez-vous réservés</strong> par vos clients.</li></ul>
      <p>Searchtide Connect <strong>ne lit pas votre agenda</strong> et ne conserve aucun jeton Google : il remet l'accès à votre instance, qui seule parle à Google. <a href="/privacy">Politique de confidentialité</a> · <a href="https://github.com/Nadir-DNA/searchtide/tree/main/relay">Code du relais</a>.</p>
      <p><a class="primary" style="display:inline-block;padding:.55rem 1rem;border-radius:999px;background:#0b6b5b;color:#fff;text-decoration:none" href="/google/go?state=${encodeURIComponent(raw)}">Continuer vers Google</a>
      <a href="${esc(st.returnUrl)}${st.returnUrl.includes("?") ? "&" : "?"}error=access_denied" style="margin-left:1rem">Annuler</a></p>`);
  }

  if (p === "/google/go" && req.method === "GET") {
    if (!await limit(await ipKey(), 60)) return tooMany();
    const raw = url.searchParams.get("state") ?? "";
    if (!await c.verifyState(raw)) { log(400); return page("Lien invalide", "<h1>Lien invalide</h1>", 400); }
    const st = await store.getState(await sha256(raw), now);
    if (!st) { log(410); return page("Demande expirée", "<h1>La demande a expiré</h1><p>Recommencez la connexion.</p>", 410); }
    const t = new URL(AUTH);
    for (const [k, v] of Object.entries({ client_id: env.GOOGLE_CLIENT_ID!, redirect_uri: `${origin}/google/callback`, response_type: "code", scope: GOOGLE_SCOPES.join(" "),
      access_type: "offline", prompt: "consent", include_granted_scopes: "false", state: raw })) t.searchParams.set(k, v);
    log(302, st.instanceId);
    return Response.redirect(t.toString(), 302);
  }

  if (p === "/google/callback" && req.method === "GET") {
    if (!await limit(await ipKey(), 60)) return tooMany();
    const raw = url.searchParams.get("state") ?? "";
    if (!await c.verifyState(raw)) { log(400); return page("Lien invalide", "<h1>Lien invalide</h1>", 400); }
    const st = await store.takeState(await sha256(raw), now);
    if (!st) { log(410); return page("Demande expirée", "<h1>La demande a expiré</h1><p>Recommencez la connexion depuis votre instance.</p>", 410); }
    const back = (q: string) => `${st.returnUrl}${st.returnUrl.includes("?") ? "&" : "?"}${q}`;
    const code = url.searchParams.get("code") ?? "";
    if (url.searchParams.get("error") || !code) { log(400, st.instanceId); return Response.redirect(back("error=access_denied"), 302); }
    const r = await call(TOKEN, { grant_type: "authorization_code", code, client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, redirect_uri: `${origin}/google/callback` });
    const tok = await r.json().catch(() => ({})) as any;
    if (!r.ok || !tok.refresh_token) { log(502, st.instanceId); return page("Google a refusé", "<h1>Google n'a pas accepté la connexion</h1><p>Recommencez depuis votre instance. Si le problème revient, retirez Searchtide Connect dans <a href=\"https://myaccount.google.com/permissions\">votre compte Google</a> puis recommencez.</p>"); }
    // Autorisation granulaire : l'utilisateur peut décocher une permission. Sans les deux, le module ne peut pas fonctionner.
    const granted = String(tok.scope ?? "").split(/\s+/);
    if (!GOOGLE_SCOPES.every((s) => granted.includes(s))) {
      await call(REVOKE, { token: tok.refresh_token }).catch(() => {});
      log(403, st.instanceId); return Response.redirect(back("error=missing_scope"), 302);
    }
    const instCode = c.random(24);
    await store.createGCode(await sha256(instCode), { instanceId: st.instanceId, challenge: st.challenge, blob: await seal(env.STATE_SECRET!, tok.refresh_token), expiresAt: now + 120_000 });
    log(200, st.instanceId);
    return Response.redirect(back(`code=${encodeURIComponent(instCode)}&state=${encodeURIComponent(raw)}`), 302);
  }

  if (p === "/v1/google/token") {
    if (req.method !== "POST") { log(405); return json({ error: "Méthode non autorisée" }, 405); }
    if (!await limit(await ipKey(), 60)) return tooMany();
    const b = await req.json().catch(() => ({})) as Record<string, string>;
    const code = String(b.code ?? ""), verifier = String(b.code_verifier ?? ""), instanceId = String(b.instance_id ?? "");
    if (!code || !verifier || !instanceId) { log(400); return json({ error: "Requête incomplète" }, 400); }
    const hash = await sha256(code);
    const g = await store.takeGCode(hash, now, async (row) => row.instanceId === instanceId && c.same(await c.pkce(verifier), row.challenge));
    if (!g) { log(400, instanceId); return json({ error: "Code invalide ou déjà utilisé" }, 400); }
    log(200, instanceId);
    return json({ refresh_token: await open(env.STATE_SECRET!, g.blob) });
  }

  if (p === "/v1/google/refresh" || p === "/v1/google/revoke") {
    if (req.method !== "POST") { log(405); return json({ error: "Méthode non autorisée" }, 405); }
    const b = await req.json().catch(() => ({})) as Record<string, string>;
    const token = String(b.refresh_token ?? "");
    if (token.length < 20 || token.length > 1024) { log(400); return json({ error: "Jeton invalide" }, 400); }
    // Plafond par jeton (pas par IP : plusieurs instances peuvent partager une adresse)
    if (!await limit(await sha256(token), p === "/v1/google/refresh" ? 240 : 20)) return tooMany();
    if (p === "/v1/google/revoke") { await call(REVOKE, { token }).catch(() => {}); log(200); return json({ ok: true }); }
    const r = await call(TOKEN, { grant_type: "refresh_token", refresh_token: token, client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET! });
    const tok = await r.json().catch(() => ({})) as any;
    if (r.status === 400 && tok.error === "invalid_grant") { log(401); return json({ error: "reconnect" }, 401); }
    if (!r.ok || !tok.access_token) { log(502); return json({ error: "google_error" }, 502); }
    log(200);
    return json({ access_token: tok.access_token, expires_in: Number(tok.expires_in ?? 3600) });
  }

  log(404);
  return json({ error: "Route inconnue" }, 404);
}
