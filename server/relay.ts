// Client du relais Searchtide Connect (OAuth Stripe). Aucune clé Stripe de plateforme ici : seulement un jeton de relais.
import { createHash, randomBytes } from "node:crypto";
import { db } from "./db.ts";

const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const sha256 = (s: string) => b64url(new Uint8Array(createHash("sha256").update(s).digest()));

export const relayUrl = () => (process.env.RELAY_URL ?? "").trim().replace(/\/$/, "");
export function relayConfigured() {
  const u = relayUrl();
  if (!u) return false;
  return /^https:\/\//.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(u);
}

/** Identifiant aléatoire de cette instance, stable, stocké dans les réglages (jamais un secret). */
export function instanceId() {
  db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)");
  const row = db.prepare("SELECT value FROM settings WHERE key = 'relay.instance_id'").get() as { value: string } | undefined;
  if (row?.value) return row.value;
  const id = `inst_${b64url(randomBytes(12))}`;
  db.prepare("INSERT INTO settings (key, value) VALUES ('relay.instance_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(id);
  return id;
}

/** État OAuth en attente (state du relais → vérificateur PKCE). En mémoire, expiration 15 min. */
const pending = new Map<string, { verifier: string; at: number }>();

export function newPkce() {
  const verifier = b64url(randomBytes(32));
  const challenge = sha256(verifier);
  return { verifier, challenge };
}

export function rememberState(state: string, verifier: string) {
  const now = Date.now();
  for (const [k, v] of pending) if (now - v.at > 15 * 60_000) pending.delete(k);
  pending.set(state, { verifier, at: now });
}
export function takeState(state: string) { const v = pending.get(state); pending.delete(state); return v && Date.now() - v.at <= 15 * 60_000 ? v.verifier : null; }

export async function relayFetch(path: string, init: RequestInit = {}) {
  const res = await fetch(`${relayUrl()}${path}`, { ...init, signal: AbortSignal.timeout(5000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `Relais ${res.status}`);
  return body;
}

let health: { at: number; ok: boolean; mode: "test" | "live" | null; google: boolean } | null = null;
export async function relayStatus(force = false) {
  if (process.env.RELAY_MOCK === "1") return { enabled: true, ok: true, mode: "test" as const, google: true, error: null };
  if (!relayConfigured()) return { enabled: false, ok: false, mode: null as "test" | "live" | null, google: false, error: "relay_url" };
  if (!force && health && Date.now() - health.at < 30_000) return { enabled: true, ok: health.ok, mode: health.mode, google: health.google, error: health.ok ? null : "unreachable" };
  try {
    const h = await relayFetch("/v1/health") as { ok?: boolean; mode?: "test" | "live"; google?: boolean };
    health = { at: Date.now(), ok: !!h.ok, mode: h.mode ?? null, google: !!h.google };
  } catch { health = { at: Date.now(), ok: false, mode: null, google: false }; }
  return { enabled: true, ok: health.ok, mode: health.mode, google: health.google, error: health.ok ? null : "unreachable" };
}

export async function relayStart(returnUrl: string, provider: "stripe" | "google" = "stripe") {
  if (process.env.RELAY_MOCK === "1") { const { verifier, challenge } = newPkce(); void challenge; const state = "mock-state"; rememberState(state, verifier); return `https://connect.test/authorize?state=${state}`; }
  const inst = instanceId();
  const { verifier, challenge } = newPkce();
  const r = await relayFetch(provider === "google" ? "/v1/google/start" : "/v1/start", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ instance_id: inst, instance_host: new URL(returnUrl).host, return_url: returnUrl, code_challenge: challenge }),
  }) as { authorize_url?: string };
  if (!r.authorize_url) throw new Error("Réponse du relais invalide");
  const state = new URL(r.authorize_url).searchParams.get("state") ?? "";
  if (!state) throw new Error("Réponse du relais invalide");
  rememberState(state, verifier);
  return r.authorize_url;
}

export async function relayExchange(code: string, verifier: string) {
  return await relayFetch("/v1/token", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, code_verifier: verifier, instance_id: instanceId() }),
  }) as { token: string; hint: string; stripe_user_id: string; livemode: boolean; mode: "test" | "live" };
}

export async function relayRevoke(token: string) {
  return await relayFetch("/v1/revoke", { method: "POST", headers: { authorization: `Bearer ${token}` } });
}

/** Échange le code d'autorisation Google contre le jeton de renouvellement (remis une seule fois par le relais). */
export async function relayGoogleToken(code: string, verifier: string) {
  return await relayFetch("/v1/google/token", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, code_verifier: verifier, instance_id: instanceId() }),
  }) as { refresh_token: string };
}
