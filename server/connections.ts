// Connecteurs OAuth : l'utilisateur autorise chez le fournisseur, Searchtide reçoit le compte
// et n'a plus besoin qu'on lui colle une clé. Le secret reste côté serveur, jamais dans l'interface.
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import type { Hono } from "hono";
import { db } from "./db.ts";

db.exec(`
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,              -- stripe
  label TEXT NOT NULL,             -- nom affiché (nom du compte chez le fournisseur)
  account TEXT NOT NULL,           -- stripe_user_id (acct_…)
  scope TEXT,                      -- read_only ou read_write
  livemode INTEGER NOT NULL DEFAULT 0,
  access_token TEXT,               -- jeton de la plateforme (peut être vide chez Stripe)
  refresh_token TEXT,              -- permet un accès durable sans redemander l'autorisation
  created_at INTEGER NOT NULL
);
`);

type Row = Record<string, any>;

export const stripeClientId = () => process.env.STRIPE_CLIENT_ID ?? "";

/** Adresse de retour : sans URL publique en HTTPS, l'autorisation ne peut pas revenir. */
export function callbackUrl() {
  const base = (process.env.PUBLIC_URL ?? "").replace(/\/$/, "");
  return base ? `${base}/api/connections/stripe/callback` : "";
}

/** state signé : empêche qu'un tiers fasse connecter un compte à votre place (CSRF d'autorisation). */
function sign(payload: string) {
  return createHmac("sha256", process.env.SECRET ?? "dev-secret").update(payload).digest("base64url");
}
export function makeState(now = Date.now()) {
  const payload = `${now}.${randomBytes(8).toString("base64url")}`;
  return `${payload}.${sign(payload)}`;
}
export function readState(state: string, maxAgeMs = 10 * 60 * 1000) {
  const [ts, rnd, sig] = state.split(".");
  if (!ts || !rnd || !sig) return false;
  const good = sign(`${ts}.${rnd}`);
  const ok = good.length === sig.length && timingSafeEqual(Buffer.from(good), Buffer.from(sig));
  return ok && Date.now() - Number(ts) < maxAgeMs;
}

export function connections(kind?: string) {
  return (kind
    ? db.prepare("SELECT id, kind, label, account, scope, livemode, created_at FROM connections WHERE kind = ? ORDER BY created_at").all(kind)
    : db.prepare("SELECT id, kind, label, account, scope, livemode, created_at FROM connections ORDER BY created_at").all()) as Row[];
}

export function connectionByAccount(account: string) {
  return db.prepare("SELECT * FROM connections WHERE kind = 'stripe' AND account = ?").get(account) as Row | undefined;
}

export function removeConnection(id: string) {
  return db.prepare("DELETE FROM connections WHERE id = ?").run(id).changes > 0;
}

export function registerConnections(app: Hono) {
  // État de la configuration, pour que l'interface n'affiche jamais un bouton mort
  app.get("/api/connections", (c) => c.json({
    stripe: { ready: !!stripeClientId() && !!callbackUrl(), callback: callbackUrl() || null },
    list: connections(),
  }));

  app.get("/api/connections/stripe/start", (c) => {
    if (!stripeClientId() || !callbackUrl()) return c.json({ error: "Connecteur Stripe non configuré : renseignez STRIPE_CLIENT_ID et PUBLIC_URL" }, 400);
    const q = new URLSearchParams({
      response_type: "code",
      client_id: stripeClientId(),
      scope: "read_only",
      state: makeState(),
      redirect_uri: callbackUrl(),
    });
    return c.json({ url: `https://connect.stripe.com/oauth/authorize?${q}` });
  });

  app.get("/api/connections/stripe/callback", async (c) => {
    const { code, state, error, error_description } = c.req.query();
    const back = (params: Record<string, string>) => c.redirect(`/?${new URLSearchParams(params)}`, 302);
    if (error) return back({ connexion: "erreur", raison: (error_description ?? error).slice(0, 120) });
    if (!code || !state || !readState(state)) return back({ connexion: "erreur", raison: "Autorisation invalide ou expirée" });

    // Échange du code contre le compte autorisé
    const res = await fetch("https://connect.stripe.com/oauth/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${process.env.STRIPE_OAUTH_SECRET_KEY ?? ""}:`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ code, grant_type: "authorization_code" }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json().catch(() => ({})) as Row;
    if (!res.ok || !data.stripe_user_id) {
      const why = data.error_description ?? data.error ?? `Stripe ${res.status}`;
      return back({ connexion: "erreur", raison: String(why).slice(0, 120) });
    }

    const account = String(data.stripe_user_id);
    const label = await accountName(account).catch(() => account);
    const id = db.prepare("SELECT id FROM connections WHERE kind = 'stripe' AND account = ?").get(account) as Row | undefined;
    const now = Date.now();
    if (id) {
      db.prepare("UPDATE connections SET label = ?, scope = ?, livemode = ?, access_token = ?, refresh_token = ? WHERE id = ?")
        .run(label, data.scope ?? "read_only", data.livemode ? 1 : 0, data.access_token ?? null, data.refresh_token ?? null, id.id);
    } else {
      db.prepare("INSERT INTO connections (id, kind, label, account, scope, livemode, access_token, refresh_token, created_at) VALUES (?, 'stripe', ?, ?, ?, ?, ?, ?, ?)")
        .run(randomBytes(8).toString("hex"), label, account, data.scope ?? "read_only", data.livemode ? 1 : 0, data.access_token ?? null, data.refresh_token ?? null, now);
    }
    return back({ connexion: "ok", compte: label });
  });

  app.delete("/api/connections/:id", (c) => removeConnection(c.req.param("id"))
    ? c.json({ ok: true })
    : c.json({ error: "Connexion introuvable" }, 404));
}

/** Nom lisible du compte, pour que l'utilisateur reconnaisse ce qu'il vient de connecter. */
async function accountName(account: string) {
  const key = process.env.STRIPE_OAUTH_SECRET_KEY ?? "";
  if (!key) return account;
  const res = await fetch("https://api.stripe.com/v1/account", {
    headers: { Authorization: `Bearer ${key}`, "Stripe-Account": account, "Stripe-Version": "2025-03-31.basil" },
    signal: AbortSignal.timeout(10_000),
  });
  const j = await res.json().catch(() => ({})) as Row;
  return String(j.business_profile?.name ?? j.settings?.dashboard?.display_name ?? account).slice(0, 80);
}
