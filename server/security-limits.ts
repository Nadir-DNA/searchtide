// SEC-01 : budgets persistés en base (un redémarrage ne remet rien à zéro).
// login : 5 échecs/15 min par IP, 15/15 min toutes sources ; 2FA : 5 par IP, 10 global, budgets séparés.
import { db } from "./db.ts";
import { securityEvent } from "./security-events.ts";

db.exec("CREATE TABLE IF NOT EXISTS rate_limits (bucket TEXT PRIMARY KEY, hits INTEGER NOT NULL, reset_at INTEGER NOT NULL)");

export const WINDOW_MS = 15 * 60_000;
export type Canal = "login" | "twofa";
export const LIMITS = { login: { ip: 5, global: 15 }, twofa: { ip: 5, global: 10 } } satisfies Record<Canal, { ip: number; global: number }>;

type RowLimit = { hits: number; reset_at: number };
const read = (bucket: string): RowLimit | undefined => db.prepare("SELECT hits, reset_at FROM rate_limits WHERE bucket = ?").get(bucket) as RowLimit | undefined;

export function blocked(canal: Canal, ip: string, now = Date.now()): boolean {
  const own = read(`${canal}:ip:${ip}`);
  if (own && own.reset_at > now && own.hits >= LIMITS[canal].ip) return true;
  const all = read(`${canal}:global`);
  return !!all && all.reset_at > now && all.hits >= LIMITS[canal].global;
}

function bump(bucket: string, now: number): number {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM rate_limits WHERE reset_at <= ?").run(now);
    const r = read(bucket);
    const active = r && r.reset_at > now;
    const hits = active ? r!.hits + 1 : 1;
    const reset = active ? r!.reset_at : now + WINDOW_MS;
    db.prepare("INSERT INTO rate_limits (bucket, hits, reset_at) VALUES (?, ?, ?) ON CONFLICT(bucket) DO UPDATE SET hits = excluded.hits, reset_at = excluded.reset_at").run(bucket, hits, reset);
    db.exec("COMMIT");
    return hits;
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}

/** Enregistre un échec et journalise le franchissement de seuil (une seule fois par fenêtre). */
export function fail(canal: Canal, ip: string, now = Date.now()) {
  const ipHits = bump(`${canal}:ip:${ip}`, now);
  const globalHits = bump(`${canal}:global`, now);
  if (ipHits === LIMITS[canal].ip) securityEvent("login_lockout", `${canal}:ip`);
  if (globalHits === LIMITS[canal].global) securityEvent("login_lockout", `${canal}:global`);
  if (globalHits > 0 && globalHits % 10 === 0) securityEvent("login_fail_burst", `${canal}:${globalHits}`);
  return { ipHits, globalHits };
}

/** Succès : seule l'IP est remise à zéro ; le budget global reste (protection contre la répartition). */
export function resetIp(canal: Canal, ip: string) {
  db.prepare("DELETE FROM rate_limits WHERE bucket = ?").run(`${canal}:ip:${ip}`);
}
