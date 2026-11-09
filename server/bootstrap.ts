// Valeurs de démarrage (T24) : SECRET et ADMIN_PASSWORD peuvent être générés au premier lancement,
// pour qu'une instance Docker démarre sans aucun fichier à éditer. Une valeur d'environnement gagne toujours.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export type BootValue = { value: string; created: boolean; file: string };

/**
 * Lit la valeur dans l'environnement, sinon dans `file`, sinon la génère et l'écrit (0600, une ligne).
 * `hex` pour un secret de chiffrement (32 octets = 64 caractères), `password` pour un mot de passe (base64url).
 */
export function bootValue(envValue: string | undefined, file: string, bytes: number, kind: "hex" | "password"): BootValue {
  const fromEnv = envValue?.trim();
  if (fromEnv) return { value: fromEnv, created: false, file };
  try {
    if (existsSync(file)) {
      const stored = readFileSync(file, "utf8").trim();
      if (stored) return { value: stored, created: false, file };
    }
  } catch { /* illisible (droits, disque) : on régénère plutôt que de démarrer sans valeur */ }
  const value = kind === "password" ? randomBytes(bytes).toString("base64url") : randomBytes(bytes).toString("hex");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, value + "\n", { mode: 0o600 });
  return { value, created: true, file };
}

/** Emplacement des fichiers de démarrage, à côté de la base (volume /data en Docker). */
export function bootFiles(dbPath: string) {
  const dir = dbPath === ":memory:" ? "data" : dirname(dbPath);
  return { secret: join(dir, "secret"), password: join(dir, "admin-password") };
}
