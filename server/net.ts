// SEC-01 : adresse source du client. Par défaut la connexion TCP ; les en-têtes de proxy ne sont
// lus que si TRUST_PROXY est défini (cloudflare, ou N = N-ième X-Forwarded-For en partant de la droite).
import type { Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";

export function clientIp(c: Context): string {
  const socket = (() => { try { return getConnInfo(c).remote.address ?? ""; } catch { return ""; } })();
  const trust = process.env.TRUST_PROXY?.trim();
  if (!trust) return socket;
  if (trust === "cloudflare") return c.req.header("cf-connecting-ip")?.trim() || socket;
  const n = Number(trust);
  if (!Number.isInteger(n) || n < 1) return socket;
  const hops = (c.req.header("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return hops[hops.length - n] || socket;
}
