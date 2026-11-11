// Double authentification dans l'interface (1.4 / 13.5-A) : secret généré côté serveur, affiché une fois,
// activé seulement après un code valide, stocké chiffré par le coffre, avec 8 codes de secours hachés.
import { createHash, randomBytes } from "node:crypto";
import QRCode from "qrcode";
import { db } from "./db.ts";
import { base32Encode, verifyTotpStep } from "./security.ts";
import { migrate } from "./migrations.ts";
import { open, openAs, seal, sealAs, secretValid } from "./vault.ts";

db.exec(`CREATE TABLE IF NOT EXISTS twofa (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pending TEXT, secret TEXT, codes TEXT, activated_at INTEGER
)`);

// Rejeu TOTP : un pas de 30 s accepté ne peut plus l'être. La colonne est ajoutée aux bases existantes.
migrate("2026-11-11-twofa-last-step", "ALTER TABLE twofa ADD COLUMN last_step INTEGER");
migrate("2026-11-11-twofa-salt", "ALTER TABLE twofa ADD COLUMN salt TEXT");

const SECRET = process.env.SECRET ?? "dev-secret";
// Codes de secours salés par ligne (indépendants de SECRET) : une rotation de SECRET ne les tue pas.
const hash = (code: string, salt: string) => createHash("sha256").update(`${salt}|${code.trim().toUpperCase()}`).digest("hex");
type Row2fa = { pending: string | null; secret: string | null; codes: string | null; salt: string | null; activated_at: number | null; last_step: number | null };
const row = () => db.prepare("SELECT pending, secret, codes, salt, activated_at, last_step FROM twofa WHERE id = 1").get() as Row2fa | undefined;

// SEC-04.3 : au démarrage, SECRET_OLD permet de rechiffrer le secret 2FA après une rotation.
const previous = process.env.SECRET_OLD?.trim();
if (previous && previous !== SECRET && secretValid(previous) && secretValid(SECRET)) {
  const r = row();
  for (const column of ["secret", "pending"] as const) {
    const blob = r?.[column];
    if (!blob) continue;
    try { db.prepare(`UPDATE twofa SET ${column} = ? WHERE id = 1`).run(sealAs(openAs(blob, previous), SECRET)); }
    catch { /* laissé en place : la connexion refusera explicitement (fail-closed) */ }
  }
}

/** Secret enregistré dans les réglages (chiffré), null si absent ou illisible. */
export function settingsSecret(): string | null {
  const r = row();
  if (!r?.secret) return null;
  try { return String(open(r.secret).secret ?? "") || null; } catch { return null; }
}

/** Une 2FA est configurée dès qu'un secret (même illisible) est présent : fail-closed. */
export const twofaConfigured = () => !!row()?.secret;
export const enabledInSettings = () => twofaConfigured();
export const backupCodesLeft = () => {
  try { return (JSON.parse(row()?.codes ?? "[]") as string[]).length; } catch { return 0; }
};

/** Étape 1 : secret provisoire et QR SVG. Rien n'est actif tant qu'un code valide n'a pas été saisi. */
export async function startSetup(): Promise<{ secret: string; qr: string }> {
  const secret = base32Encode(randomBytes(20));
  db.prepare("INSERT INTO twofa (id, pending) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET pending = excluded.pending").run(seal({ secret }));
  const uri = `otpauth://totp/Searchtide?secret=${secret}&issuer=Searchtide`;
  return { secret, qr: await QRCode.toString(uri, { type: "svg", margin: 1, width: 180 }) };
}

/** Étape 2 : active le secret provisoire après vérification ; renvoie les 8 codes de secours en clair, une fois. */
export type FactorResult = "ok" | "replay" | "invalid";

export function activate(code: string): string[] | null {
  const r = row();
  if (!r?.pending) return null;
  let secret: string;
  try { secret = String(open(r.pending).secret ?? ""); } catch { return null; }
  const step = secret ? verifyTotpStep(secret, code.replace(/\s/g, "")) : null;
  if (!secret || step === null) return null;
  const codes = Array.from({ length: 8 }, () => randomBytes(5).toString("hex").toUpperCase());
  const salt = randomBytes(16).toString("hex");
  // Le code d'activation est consommé : la première connexion exige le pas suivant.
  // Mono-activation : pending passe à NULL. last_step repart du pas d'activation (nouveau secret).
  const upd = db.prepare(`UPDATE twofa SET pending = NULL, secret = ?, codes = ?, salt = ?, activated_at = ?, last_step = ?
    WHERE id = 1 AND pending IS NOT NULL`).run(seal({ secret }), JSON.stringify(codes.map((c) => hash(c, salt))), salt, Date.now(), step);
  return Number(upd.changes) === 1 ? codes : null;
}

/** Code de secours à usage unique : haché, retiré dès qu'il sert (transaction). */
export function consumeBackup(code: string): boolean {
  const r = row();
  if (!r?.codes || !r.salt) return false;
  const list = JSON.parse(r.codes) as string[];
  const i = list.indexOf(hash(code, r.salt));
  if (i < 0) return false;
  list.splice(i, 1);
  // Mise à jour conditionnelle : un autre processus qui a déjà consommé ce code fait échouer changes.
  const upd = db.prepare("UPDATE twofa SET codes = ? WHERE id = 1 AND codes = ?").run(JSON.stringify(list), r.codes);
  return Number(upd.changes) === 1;
}

/**
 * Consomme atomiquement un pas TOTP : deux connexions concurrentes avec le même code
 * ne peuvent pas réussir toutes les deux. Retourne false si le pas a déjà servi.
 */
export function consumeTotp(secret: string, code: string, now = Date.now()): FactorResult {
  const step = verifyTotpStep(secret, code.replace(/\s/g, ""), now);
  if (step === null) return "invalid";
  // Une seule instruction : UPDATE conditionnel, atomique même avec plusieurs processus.
  const upd = db.prepare(`INSERT INTO twofa (id, last_step) VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET last_step = excluded.last_step
    WHERE twofa.last_step IS NULL OR twofa.last_step < excluded.last_step`).run(step);
  return Number(upd.changes) === 1 ? "ok" : "replay";
}

/** Code du réglage (TOTP consommé, sinon code de secours consommé). */
export function consumeSecondFactor(code: string): FactorResult {
  const secret = settingsSecret();
  if (!secret) return "invalid";
  const clean = code.replace(/\s/g, "");
  if (/^\d{6}$/.test(clean)) {
    const r = consumeTotp(secret, clean);
    if (r !== "invalid") return r;
  }
  return consumeBackup(clean) ? "ok" : "invalid";
}

export function disable() {
  db.prepare("UPDATE twofa SET pending = NULL, secret = NULL, codes = NULL, activated_at = NULL WHERE id = 1").run();
}
