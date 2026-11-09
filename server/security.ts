// Sécurité de l'instance : limite des essais de connexion, double authentification (TOTP), sauvegardes.
import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { db } from "./db.ts";

/** 5 échecs en 15 minutes par adresse IP, puis blocage jusqu'à la fin de la fenêtre. */
export function loginLimiter(max = 5, windowMs = 15 * 60 * 1000) {
  const hits = new Map<string, { n: number; until: number }>();
  return {
    blocked(ip: string, now = Date.now()) { const h = hits.get(ip); return !!h && h.until > now && h.n >= max; },
    fail(ip: string, now = Date.now()) {
      const h = hits.get(ip);
      hits.set(ip, h && h.until > now ? { n: h.n + 1, until: h.until } : { n: 1, until: now + windowMs });
      if (hits.size > 10_000) for (const [k, v] of hits) if (v.until <= now) hits.delete(k);
    },
    reset(ip: string) { hits.delete(ip); },
  };
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32Decode(s: string) {
  let bits = "";
  for (const c of s.toUpperCase().replace(/=+$|\s/g, "")) {
    const i = B32.indexOf(c);
    if (i < 0) throw new Error("Secret TOTP invalide");
    bits += i.toString(2).padStart(5, "0");
  }
  return Buffer.from(bits.match(/.{8}/g)?.map((b) => parseInt(b, 2)) ?? []);
}
export function base32Encode(buf: Buffer) {
  const bits = [...buf].map((b) => b.toString(2).padStart(8, "0")).join("");
  return (bits.match(/.{1,5}/g) ?? []).map((b) => B32[parseInt(b.padEnd(5, "0"), 2)]).join("");
}

/** Code à 6 chiffres (RFC 6238, pas de 30 s, HMAC-SHA1), compatible Google Authenticator, Authy… */
export function totp(secret: string, now = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const h = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
/** Accepte le code courant et ceux des 30 s avant et après (horloges décalées). */
export function verifyTotp(secret: string, code: string, now = Date.now()) {
  if (!/^\d{6}$/.test(code)) return false;
  return [-1, 0, 1].some((w) => timingSafeEqual(Buffer.from(totp(secret, now + w * 30_000)), Buffer.from(code)));
}

/** Copie cohérente de la base (même pendant l'écriture), en gardant les `keep` plus récentes. */
export function backup(dir: string, keep = 14, now = new Date()) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `searchtide-${now.toISOString().slice(0, 10)}.db`);
  rmSync(file, { force: true });
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const old = readdirSync(dir).filter((f) => /^searchtide-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().slice(0, -keep);
  for (const f of old) rmSync(join(dir, f));
  return file;
}
