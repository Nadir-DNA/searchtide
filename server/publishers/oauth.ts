// Connexion d'un compte de publication par OAuth (MIT) : « Connecter », autorisation chez le réseau, jeton dans le coffre.
// L'autorisation est liée à la session administrateur qui l'ouvre : état à usage unique, dix minutes, et plafond de départs par minute.
import type { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { createHash, randomBytes } from "node:crypto";
import { db } from "../db.ts";
import { isAdmin } from "../admin.ts";
import { createConnection, findByFingerprint, setSecrets, markStatus } from "../connections.ts";
import { createConnectedAccount } from "./queue.ts";
import { providerFor } from "./provider.ts";

const origin = (c: any) => (process.env.PUBLIC_URL ?? new URL(c.req.url).origin).replace(/\/$/, "");
const fail = (msg: string) => `/?view=connections&oauth=${encodeURIComponent(msg)}`;

const TTL = 10 * 60_000;
const MAX_PENDING = 30;
const STARTS_PER_WINDOW = 10;
const START_WINDOW = 60_000;
type Pending = { project: string; network: string; exp: number; sid: string };
const states = new Map<string, Pending>();
const starts = new Map<string, { n: number; reset: number }>();

/** Empreinte du cookie de session administrateur (une seule valeur par mot de passe, sans identifiant d'onglet) :
 *  un état ouvert ici ne se termine pas avec un autre identifiant. */
const sessionId = (c: any) => createHash("sha256").update(getCookie(c, "st_session") ?? "").digest("hex").slice(0, 16);

/** Retire l'état, qui ne sert qu'une fois et seulement dans la session qui l'a créé (sinon il expire seul). */
function take(s: string, sid: string, now = Date.now()) {
  const v = states.get(s);
  if (!v || v.sid !== sid) return undefined;
  states.delete(s);
  return v.exp > now ? v : undefined;
}

/** Départs par session et par minute : un bouton ne peut pas ouvrir des dizaines d'autorisations. */
function countStart(sid: string, now: number): boolean {
  for (const [k, v] of starts) if (v.reset <= now) starts.delete(k);
  const w = starts.get(sid);
  const n = w ? w.n + 1 : 1;
  starts.set(sid, { n, reset: w ? w.reset : now + START_WINDOW });
  return n <= STARTS_PER_WINDOW;
}

export function registerPublisherOAuth(app: Hono) {
  const redirect = (c: any, network: string) => `${origin(c)}/api/pub-oauth/${network}/callback`;

  app.post("/api/pub-oauth/:network/start", async (c) => {
    if (!isAdmin(c)) return c.json({ error: "Réservé à l'administrateur" }, 403);
    if (process.env.DEMO === "1") return c.json({ error: "Désactivé en démonstration." }, 403);
    const network = c.req.param("network"), provider = providerFor(network);
    if (!provider) return c.json({ error: "Réseau non pris en charge" }, 400);
    if (!provider.configured()) return c.json({ error: `Définissez ${network.toUpperCase()}_CLIENT_ID et ${network.toUpperCase()}_CLIENT_SECRET (application développeur du réseau), puis redémarrez.` }, 400);
    const now = Date.now(), sid = sessionId(c);
    if (!countStart(sid, now)) return c.json({ error: "Trop de tentatives de connexion. Réessayez dans une minute." }, 429);
    for (const [k, v] of states) if (v.exp <= now) states.delete(k);
    if (states.size >= MAX_PENDING) return c.json({ error: "Trop de connexions en attente. Recommencez dans quelques minutes." }, 429);
    const project = String((await c.req.json().catch(() => ({}))).project ?? "").trim();
    if (!db.prepare("SELECT 1 FROM projects WHERE id = ? OR crm_key = ?").get(project, project)) return c.json({ error: "Projet introuvable" }, 400);
    const state = randomBytes(16).toString("hex");
    states.set(state, { project, network, exp: now + TTL, sid });
    return c.json({ url: provider.authUrl(redirect(c, network), state) });
  });

  app.get("/api/pub-oauth/:network/callback", async (c) => {
    if (!isAdmin(c)) return c.redirect("/?view=connections&oauth=admin");
    const network = c.req.param("network"), provider = providerFor(network);
    // L'état est consommé même quand l'autorisation est refusée : il ne resservira pas.
    const st = take(c.req.query("state") ?? "", sessionId(c)), code = c.req.query("code") ?? "";
    if (c.req.query("error")) return c.redirect(fail("Autorisation refusée. Recommencez la connexion."));
    if (!provider || !st || st.network !== network || !code) return c.redirect(fail("La demande a expiré. Recommencez la connexion."));
    try {
      const t = await provider.exchange(code, redirect(c, network));
      const secrets = { access_token: t.accessToken, refresh_token: t.refreshToken ?? null, expires_at: t.expiresAt ?? null };
      const fp = `${network}:${t.accountId}`;
      const existing = findByFingerprint(network, fp);
      const conn = existing ?? createConnection({ kind: network, label: t.name, account: t.accountId, secrets, fingerprintOf: fp });
      if (existing) { setSecrets(existing.id, secrets); markStatus(existing.id, "connected", null); }
      const known = db.prepare("SELECT id FROM pub_accounts WHERE connection_id = ? AND project = ?").get(conn.id, st.project) as { id: string } | undefined;
      if (known) db.prepare("UPDATE pub_accounts SET status = 'connected' WHERE id = ?").run(known.id);
      else createConnectedAccount({ project: st.project, network, label: t.name, connection_id: conn.id });
      return c.redirect("/?view=connections&oauth=ok");
    } catch (e) { return c.redirect(fail((e as Error).message)); }
  });
}
