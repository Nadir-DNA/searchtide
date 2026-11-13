// « Connexion avec Stripe » côté instance : le jeton du relais est stocké dans le coffre, jamais la clé de plateforme.
import type { Hono } from "hono";
import { isAdmin } from "./admin.ts";
import { createConnection, findByFingerprint, getSecrets, removeConnection, setSecrets } from "./connections.ts";
import { instanceId, relayConfigured, relayExchange, relayFetch, relayRevoke, relayStart, relayStatus, relayUrl, takeState } from "./relay.ts";

const DEMO = () => process.env.DEMO === "1";
const origin = (c: any) => (process.env.PUBLIC_URL ?? new URL(c.req.url).origin).replace(/\/$/, "");
const fail = (msg: string) => `/?view=connections&oauth=${encodeURIComponent(msg)}`;

export function registerStripeOAuth(app: Hono) {
  app.get("/api/stripe-oauth/status", async (c) => {
    if (!isAdmin(c)) return c.json({ error: "Réservé à l'administrateur" }, 403);
    if (DEMO()) return c.json({ enabled: false, ok: false, mode: null, error: "demo" });
    return c.json({ ...(await relayStatus()), url: relayUrl() });
  });

  app.post("/api/stripe-oauth/start", async (c) => {
    if (!isAdmin(c)) return c.json({ error: "Réservé à l'administrateur" }, 403);
    if (DEMO()) return c.json({ error: "Désactivé en démonstration." }, 403);
    if (!relayConfigured()) return c.json({ error: "Relais non configuré" }, 400);
    const st = await relayStatus();
    if (!st.ok) return c.json({ error: "Le service Searchtide Connect ne répond pas. Réessayez, ou utilisez une clé limitée." }, 502);
    try {
      const url = await relayStart(`${origin(c)}/api/stripe-oauth/callback`);
      return c.json({ url });
    } catch (e) { return c.json({ error: (e as Error).message }, 502); }
  });

  app.get("/api/stripe-oauth/callback", async (c) => {
    if (!isAdmin(c)) return c.redirect("/?view=connections&oauth=admin");
    const state = c.req.query("state") ?? "", code = c.req.query("code") ?? "";
    if (c.req.query("error")) return c.redirect(fail("Stripe n'a pas reçu votre autorisation. Recommencez, ou utilisez une clé limitée."));
    const verifier = takeState(state);
    if (!verifier || !code) return c.redirect(fail("La demande a expiré. Recommencez la connexion."));
    let t: Awaited<ReturnType<typeof relayExchange>>;
    try { t = await relayExchange(code, verifier); }
    catch { return c.redirect(fail("Le service Searchtide Connect ne répond pas. Réessayez, ou utilisez une clé limitée.")); }
    // Nom du compte (lecture via le jeton neuf, aucune donnée conservée)
    let accountName = "Compte Stripe", currency = "";
    try {
      const r = await fetch(`${(process.env.RELAY_URL ?? "").replace(/\/$/, "")}/v1/stripe/read`, { method: "POST", headers: { authorization: `Bearer ${t.token}`, "content-type": "application/json" }, body: JSON.stringify({ object: "account", params: {} }) });
      if (r.ok) { const a = await r.json() as any; accountName = String(a.business_profile?.name ?? "Compte Stripe"); currency = String(a.default_currency ?? "").toLowerCase(); }
    } catch { /* facultatif */ }
    const config = { relay: true, relay_url: (process.env.RELAY_URL ?? "").replace(/\/$/, ""), account_name: accountName, livemode: !!t.livemode, mode: t.mode, hint: t.hint, ...(currency ? { currency } : {}) };
    const existing = findByFingerprint("stripe", `relay:${t.stripe_user_id}`);
    if (existing) { setSecrets(existing.id, { token: t.token }); }
    else createConnection({ kind: "stripe", label: t.mode === "test" ? `${accountName} (test)` : accountName, config, secrets: { token: t.token }, fingerprintOf: `relay:${t.stripe_user_id}`, livemode: !!t.livemode });
    return c.redirect("/?view=connections&oauth=ok");
  });
}

/** Révoque côté relais (au mieux) puis supprime la connexion locale. */
export async function revokeRelayToken(id: string): Promise<boolean> {
  const { db } = await import("./db.ts");
  const row = db.prepare("SELECT config FROM connections WHERE id = ?").get(id) as { config: string } | undefined;
  if (!row) return true;
  let cfg: any = {}; try { cfg = JSON.parse(row.config); } catch {}
  if (!cfg?.relay) return true;
  try {
    const s = getSecrets(id);
    if (s.refresh_token) await relayFetch("/v1/google/revoke", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refresh_token: s.refresh_token }) });
    else if (s.token) await relayRevoke(String(s.token));
    return true;
  }
  catch { return false; }
}
