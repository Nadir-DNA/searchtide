// SPDX-License-Identifier: AGPL-3.0-only
// Outils communs aux fournisseurs : délai, PKCE, lecture JSON, correspondance des erreurs HTTP.
import { createHash } from "node:crypto";
import type { FailureKind, PublishResult } from "../provider.ts";

export const TIMEOUT = 60_000;
export const f = (url: string, init: RequestInit = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) });
export const json = async (r: Response) => await r.json().catch(() => ({})) as any;
export const challenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");
export const blob = (b: Buffer, mime: string) => new Blob([new Uint8Array(b)], { type: mime });

export const fail = (kind: FailureKind, message: string): PublishResult => ({ ok: false, kind, message });
export const pending = (message: string, data: Record<string, unknown>): PublishResult => ({ ok: false, kind: "pending", message, data });

/** Avant le geste final, un refus est certain : rien n'est publié. */
export function before(net: string, status: number, detail = ""): PublishResult {
  if (status === 401) return fail("auth", `${net} : jeton refusé, reconnectez le compte`);
  if (status === 429) return fail("rate", `${net} : limite de débit atteinte`);
  if (status >= 500) return fail("network", `${net} : erreur ${status} pendant l'envoi du média`);
  return fail("format", `${net} a refusé l'envoi (${status}) ${detail}`.trim());
}

/** Au geste final, un 5xx ou une coupure laisse un doute : à vérifier, jamais rejoué. */
export function final(net: string, status: number, detail = ""): PublishResult {
  if (status >= 500) return fail("to_verify", `${net} : erreur ${status}, vérifiez sur le réseau`);
  return before(net, status, detail);
}
export const unknown = (net: string, e: unknown): PublishResult => fail("to_verify", `${net} : réponse inconnue (${(e as Error).message}), vérifiez sur le réseau`);
