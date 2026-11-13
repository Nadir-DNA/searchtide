// « Connecter Google Agenda » côté instance, par le relais Searchtide Connect : le jeton de renouvellement va dans le coffre,
// jamais le secret de l'application Google (il reste sur le relais).
import type { Hono } from "hono";
import { isAdmin } from "./admin.ts";
import { createConnection, findByFingerprint, markStatus, setSecrets } from "./connections.ts";
import { relayConfigured, relayGoogleToken, relayStart, relayStatus, relayUrl, takeState } from "./relay.ts";
import { whoami } from "./gcal.ts";

const DEMO = () => process.env.DEMO === "1";
const origin = (c: any) => (process.env.PUBLIC_URL ?? new URL(c.req.url).origin).replace(/\/$/, "");
const back = (msg: string) => `/?view=rdv&gcal=${encodeURIComponent(msg)}`;

export function registerGoogleOAuth(app: Hono) {
  app.get("/api/google-oauth/status", async (c) => {
    if (!isAdmin(c)) return c.json({ error: "Réservé à l'administrateur" }, 403);
    if (DEMO()) return c.json({ enabled: false, ok: false, google: false });
    const st = await relayStatus();
    return c.json({ enabled: st.enabled, ok: st.ok, google: st.google, url: relayUrl() });
  });

  app.post("/api/google-oauth/start", async (c) => {
    if (!isAdmin(c)) return c.json({ error: "Réservé à l'administrateur" }, 403);
    if (DEMO()) return c.json({ error: "Désactivé en démonstration." }, 403);
    if (!relayConfigured()) return c.json({ error: "Relais non configuré : définissez RELAY_URL." }, 400);
    const st = await relayStatus();
    if (!st.ok || !st.google) return c.json({ error: "Le service Searchtide Connect ne propose pas Google Agenda pour le moment." }, 502);
    try { return c.json({ url: await relayStart(`${origin(c)}/api/google-oauth/callback`, "google") }); }
    catch (e) { return c.json({ error: (e as Error).message }, 502); }
  });

  app.get("/api/google-oauth/callback", async (c) => {
    if (!isAdmin(c)) return c.redirect(back("Reconnectez-vous en administrateur, puis recommencez."));
    const err = c.req.query("error");
    if (err) return c.redirect(back(err === "missing_scope" ? "Les deux autorisations sont nécessaires (voir vos occupations, gérer vos rendez-vous). Recommencez et laissez-les cochées." : "Google n'a pas reçu votre autorisation. Recommencez."));
    const verifier = takeState(c.req.query("state") ?? ""), code = c.req.query("code") ?? "";
    if (!verifier || !code) return c.redirect(back("La demande a expiré. Recommencez la connexion."));
    try {
      const { refresh_token } = await relayGoogleToken(code, verifier);
      const relay_url = relayUrl();
      const me = await whoami({ config: { relay_url }, secrets: { refresh_token } });
      const config = { relay: true, relay_url, email: me.name, calendar_id: "primary", hint: `${me.name} · via Searchtide Connect` };
      const existing = findByFingerprint("gcal", `gcal:${me.name}`);
      if (existing) { setSecrets(existing.id, { refresh_token }); markStatus(existing.id, "connected"); }
      else createConnection({ kind: "gcal", label: me.name, account: me.name, config, secrets: { refresh_token }, fingerprintOf: `gcal:${me.name}` });
      return c.redirect(back("ok"));
    } catch (e) { return c.redirect(back(`Connexion impossible : ${(e as Error).message}`)); }
  });
}
