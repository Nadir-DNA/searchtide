// Coffre : chiffre les clés et jetons des connexions avec une clé dérivée de SECRET.
// AES-256-GCM (confidentialité + intégrité), clé par HKDF-SHA256 avec une étiquette de contexte,
// nonce aléatoire de 12 octets par enregistrement. Aucune dépendance : node:crypto seulement.
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

export const SECRET_MIN = 32;
export const SECRET_MESSAGE = "Ajoutez une valeur SECRET de 32 caractères ou plus dans .env, puis redémarrez. Elle chiffre vos clés.";
export const RECONNECT_MESSAGE = "À reconnecter : la clé de l'instance a changé";

/** Erreur du coffre. `secret-invalid` : pas de SECRET valable (refus d'enregistrer). `undecryptable` : SECRET changé ou donnée altérée. */
export class VaultError extends Error {
  code: "secret-invalid" | "undecryptable";
  constructor(code: "secret-invalid" | "undecryptable", message: string) { super(message); this.name = "VaultError"; this.code = code; }
}

const currentSecret = () => process.env.SECRET ?? "";
/** SECRET absent, égal à `dev-secret` ou de moins de 32 caractères : pas de coffre (règle R2). */
export const secretValid = (secret = currentSecret()) => !!secret && secret !== "dev-secret" && secret.length >= SECRET_MIN;

// Les clés dérivées sont gardées en mémoire par valeur de SECRET (la valeur peut changer entre deux appels dans les tests)
const cache = new Map<string, { enc: Buffer; mac: Buffer }>();
function keys() {
  const secret = currentSecret();
  if (!secretValid(secret)) throw new VaultError("secret-invalid", SECRET_MESSAGE);
  let k = cache.get(secret);
  if (!k) {
    const derive = (info: string) => Buffer.from(hkdfSync("sha256", secret, "searchtide/vault", info, 32));
    k = { enc: derive("searchtide/secrets/v1"), mac: derive("searchtide/fingerprint/v1") };
    if (cache.size > 4) cache.clear();
    cache.set(secret, k);
  }
  return k;
}

const AAD = Buffer.from("searchtide/connection");
const b64 = (b: Buffer) => b.toString("base64url");

/** Chiffre un objet de secrets : `v1.nonce.chiffré.étiquette` (base64url). */
const keysFor = (secret: string) => {
  if (!secretValid(secret)) throw new VaultError("secret-invalid", SECRET_MESSAGE);
  const derive = (info: string) => Buffer.from(hkdfSync("sha256", secret, "searchtide/vault", info, 32));
  return { enc: derive("searchtide/secrets/v1"), mac: derive("searchtide/fingerprint/v1") };
};

export function seal(obj: Record<string, unknown>): string {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keys().enc, nonce);
  c.setAAD(AAD);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return ["v1", b64(nonce), b64(ct), b64(c.getAuthTag())].join(".");
}

/** Chiffrement avec un SECRET explicite (rotation uniquement). */
export function sealAs(obj: Record<string, unknown>, secret: string): string {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keysFor(secret).enc, nonce);
  c.setAAD(AAD);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return ["v1", b64(nonce), b64(ct), b64(c.getAuthTag())].join(".");
}

/** Déchiffrement avec un SECRET explicite (rotation uniquement). */
export function openAs(blob: string, secret: string): Record<string, any> {
  const [v, nonce, ct, tag] = blob.split(".");
  if (v !== "v1" || !nonce || !ct || !tag) throw new VaultError("undecryptable", RECONNECT_MESSAGE);
  try {
    const d = createDecipheriv("aes-256-gcm", keysFor(secret).enc, Buffer.from(nonce, "base64url"));
    d.setAAD(AAD); d.setAuthTag(Buffer.from(tag, "base64url"));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8"));
  } catch { throw new VaultError("undecryptable", RECONNECT_MESSAGE); }
}

/** Déchiffre. Échec (autre SECRET, donnée altérée) : `VaultError("undecryptable")`, jamais une exception brute. */
export function open(blob: string | null | undefined): Record<string, any> {
  if (!blob) return {};
  const k = keys();
  try {
    const [v, nonce, ct, tag] = blob.split(".");
    if (v !== "v1" || !nonce || !ct || !tag) throw new Error("format");
    const d = createDecipheriv("aes-256-gcm", k.enc, Buffer.from(nonce, "base64url"));
    d.setAAD(AAD);
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8"));
  } catch { throw new VaultError("undecryptable", RECONNECT_MESSAGE); }
}

/** Empreinte HMAC d'un secret pour détecter les doublons sans le stocker (R10). */
export function fingerprint(kind: string, value: string): string {
  return createHmac("sha256", keys().mac).update(`${kind}|${value}`).digest("hex");
}

/** Remplace par `•••` toute sous-chaîne égale à un secret (R4). Les valeurs trop courtes sont ignorées pour ne pas casser le texte. */
export function scrub(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join("•••");
  return out;
}

/** Clés d'un objet JSON secret dont la valeur est sensible (le reste, comme client_email ou project_id, peut être affiché). */
const SENSITIVE_KEY = /private|secret|token|pass|key/i;

/** Valeurs à masquer dans un objet de secrets. Une chaîne JSON (fichier de compte de service) est masquée en entier ; ses seules valeurs sensibles le sont aussi séparément. */
export function secretValues(obj: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, sensitive: boolean) => {
    if (typeof v === "string") {
      if (sensitive) out.push(v);
      if (v.startsWith("{")) try { walk(JSON.parse(v), false); } catch { /* pas du JSON */ }
    } else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, sensitive || SENSITIVE_KEY.test(k));
  };
  // Les valeurs de premier niveau d'un objet de secrets sont toutes sensibles
  if (obj && typeof obj === "object") for (const x of Object.values(obj)) walk(x, true); else walk(obj, true);
  return out;
}
