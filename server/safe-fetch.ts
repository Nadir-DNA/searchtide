// Lecture d'une page publique côté serveur, sans jamais joindre une adresse interne (SSRF).
// L'adresse est vérifiée au moment même de la résolution DNS (option lookup de node:http), donc pas de
// rebinding entre la vérification et la connexion ; chaque redirection est revérifiée. Taille et durée bornées.
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import type { LookupFunction } from "node:net";
import { exoticNumeric, isForbiddenIp, isForbiddenName } from "./browser/netguard.ts";

export type SafeResponse = { status: number; url: string; headers: Record<string, string>; body: string; ms: number; bytes: number; truncated: boolean };
export class SafeFetchError extends Error {}

const UA = "SearchtideBot/0.5 (+https://github.com/Nadir-DNA/searchtide)";

/** Résolution filtrée : refuse si une seule des adresses est interne. Remplaçable dans les tests. */
export let resolveHost: (host: string) => Promise<string[]> = async (host) =>
  (await dns.promises.lookup(host, { all: true, verbatim: true })).map((a) => a.address);
export const setResolver = (fn: typeof resolveHost) => { resolveHost = fn; };

const guardedLookup: LookupFunction = (host, options, cb) => {
  resolveHost(host).then((addrs) => {
    const bad = addrs.find((a) => isForbiddenIp(a));
    if (!addrs.length || bad) return cb(new SafeFetchError(`Adresse refusée pour ${host}`), "", 0);
    const pick = addrs[0];
    if ((options as { all?: boolean }).all) return (cb as any)(null, addrs.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));
    cb(null, pick, pick.includes(":") ? 6 : 4);
  }, (e) => cb(e, "", 0));
};

export function checkUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new SafeFetchError("Adresse invalide"); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new SafeFetchError("Seules les adresses http et https sont acceptées");
  if (u.username || u.password) throw new SafeFetchError("Adresse avec identifiants refusée");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isForbiddenName(host) || exoticNumeric(host)) throw new SafeFetchError("Adresse interne refusée");
  if (u.port && !["80", "443"].includes(u.port)) throw new SafeFetchError("Port non standard refusé");
  return u;
}

function once(u: URL, maxBytes: number, timeoutMs: number): Promise<SafeResponse & { location?: string }> {
  const lib = u.protocol === "https:" ? https : http;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const req = lib.request(u, { method: "GET", lookup: guardedLookup, timeout: timeoutMs, headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,application/xml,text/plain;q=0.9,*/*;q=0.5" } }, (res) => {
      const chunks: Buffer[] = [];
      let bytes = 0, truncated = false;
      res.on("data", (c: Buffer) => {
        if (truncated) return;
        bytes += c.length;
        if (bytes > maxBytes) { truncated = true; chunks.push(c.subarray(0, c.length - (bytes - maxBytes))); res.destroy(); return; }
        chunks.push(c);
      });
      const done = () => resolve({
        status: res.statusCode ?? 0, url: u.toString(), ms: Date.now() - started, bytes: Math.min(bytes, maxBytes), truncated,
        headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v ?? "")])),
        body: Buffer.concat(chunks).toString("utf8"), location: typeof res.headers.location === "string" ? res.headers.location : undefined,
      });
      res.on("end", done);
      res.on("close", done);
      res.on("error", (e) => (truncated ? done() : reject(e)));
    });
    req.on("timeout", () => req.destroy(new SafeFetchError(`Délai dépassé (${Math.round(timeoutMs / 1000)} s)`)));
    req.on("error", reject);
    req.end();
  });
}

/** GET avec redirections suivies (3 au plus), chacune revérifiée par `allow` puis par le filtre d'adresses. */
export async function safeGet(raw: string, o: { maxBytes?: number; timeoutMs?: number; allow?: (u: URL) => boolean } = {}) {
  let u = checkUrl(raw);
  const hops: string[] = [];
  for (let i = 0; i <= 3; i++) {
    if (o.allow && !o.allow(u)) throw new SafeFetchError(`Domaine non autorisé : ${u.hostname}`);
    const r = await once(u, o.maxBytes ?? 2_500_000, o.timeoutMs ?? 10_000);
    if (r.status >= 300 && r.status < 400 && r.location) {
      hops.push(u.toString());
      u = checkUrl(new URL(r.location, u).toString());
      continue;
    }
    return { ...r, redirects: hops };
  }
  throw new SafeFetchError("Trop de redirections");
}
