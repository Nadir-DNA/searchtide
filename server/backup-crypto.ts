// P1-B : sauvegarde externe chiffrée (v2). AES-256-GCM, clé scrypt d'une phrase de passe distincte de SECRET.
// Le lot local reste en clair (droits 600) ; les anciens lots v1 restent lisibles.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { decodeBundle, type DecodedBundle } from "./backup-bundle.ts";

export type BundlePayload = { version: number; day: string; db: string; secret: string | null; adminPassword: string | null };
const MIN_PASS = 16;
const N = 2 ** 17, R = 8, P = 1, MAXMEM = 512 * 1024 * 1024;
const aad = (n: number, r: number, p: number) => Buffer.from(`searchtide-backup-v2|n=${n}|r=${r}|p=${p}`);
const checkPass = (pass: string) => { if (pass.length < MIN_PASS) throw new Error(`Phrase de passe trop courte : ${MIN_PASS} caractères minimum`); };

export function encryptBundle(payload: BundlePayload, passphrase: string): Buffer {
  checkPass(passphrase);
  const salt = randomBytes(16), iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32, { N, r: R, p: P, maxmem: MAXMEM });
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(aad(N, R, P));
  const data = Buffer.concat([c.update(JSON.stringify(payload), "utf8"), c.final()]);
  return Buffer.from(JSON.stringify({ version: 2, day: payload.day, n: N, r: R, p: P, salt: salt.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") }));
}

/** Déchiffre v2, ou lit un lot v1 (gzip) pour compatibilité. */
export function decodeAnyBundle(buf: Buffer, passphrase?: string | null): { payload: DecodedBundle; legacy: boolean } {
  let parsed: { version?: number; n?: number; r?: number; p?: number; salt?: string; iv?: string; tag?: string; data?: string } | null = null;
  try { parsed = JSON.parse(buf.toString("utf8")); } catch { parsed = null; }
  if (parsed?.version === 2) {
    if (!passphrase) throw new Error("Phrase de passe requise pour cette sauvegarde chiffrée");
    const n = parsed.n ?? 16384, r = parsed.r ?? 8, p = parsed.p ?? 1;
    if (n < 2 ** 14 || n > 2 ** 20 || r > 16 || p > 4) throw new Error("Paramètres scrypt invalides dans l'en-tête");
    const key = scryptSync(passphrase, Buffer.from(parsed.salt!, "base64"), 32, { N: n, r, p, maxmem: MAXMEM });
    const open = (aadBuf: Buffer) => {
      const d = createDecipheriv("aes-256-gcm", key, Buffer.from(parsed.iv!, "base64"));
      d.setAAD(aadBuf); d.setAuthTag(Buffer.from(parsed.tag!, "base64"));
      return JSON.parse(Buffer.concat([d.update(Buffer.from(parsed.data!, "base64")), d.final()]).toString("utf8")) as BundlePayload;
    };
    try {
      // Nouveaux lots : paramètres dans l'AAD. Anciens v2 (sans n/r/p) : AAD historique.
      const json = parsed.n === undefined ? (() => { const d = createDecipheriv("aes-256-gcm", key, Buffer.from(parsed.iv!, "base64")); d.setAAD(Buffer.from("searchtide-backup-v2")); d.setAuthTag(Buffer.from(parsed.tag!, "base64")); return JSON.parse(Buffer.concat([d.update(Buffer.from(parsed.data!, "base64")), d.final()]).toString("utf8")) as BundlePayload; })() : open(aad(n, r, p));
      return { payload: { day: json.day, db: Buffer.from(json.db, "base64"), secret: json.secret ? Buffer.from(json.secret, "base64").toString() : null, adminPassword: json.adminPassword ? Buffer.from(json.adminPassword, "base64").toString() : null }, legacy: false };
    } catch { throw new Error("Phrase de passe incorrecte ou sauvegarde altérée (authentification GCM)"); }
  }
  return { payload: decodeBundle(buf), legacy: true };
}

/** Construit et chiffre le lot depuis les fichiers de sauvegarde locaux. */
export function encryptedBundle(dbFile: string, secretFile: string, passwordFile: string, day: string, passphrase: string): Buffer {
  const text = (f: string) => (existsSync(f) ? readFileSync(f).toString("base64") : null);
  return encryptBundle({ version: 2, day, db: readFileSync(dbFile).toString("base64"), secret: text(secretFile), adminPassword: text(passwordFile) }, passphrase);
}
