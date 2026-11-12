// SEC-03 : cookie de session révocable. Valeur admin.<epoch>.<empreinte du mot de passe>.
// epoch est en base : logout, activation et désactivation de la 2FA incrémentent et invalident tous les cookies.
import { createHash } from "node:crypto";
import { db } from "./db.ts";

db.exec("CREATE TABLE IF NOT EXISTS session_state (id INTEGER PRIMARY KEY CHECK (id = 1), epoch INTEGER NOT NULL DEFAULT 0)");
db.prepare("INSERT OR IGNORE INTO session_state (id, epoch) VALUES (1, 0)").run();

export const sessionEpoch = () => (db.prepare("SELECT epoch FROM session_state WHERE id = 1").get() as { epoch: number }).epoch;
export function bumpEpoch() { db.prepare("UPDATE session_state SET epoch = epoch + 1 WHERE id = 1").run(); }
export const passwordFingerprint = (password: string) => createHash("sha256").update(password).digest("hex").slice(0, 8);
export const sessionValue = (password: string) => `admin.${sessionEpoch()}.${passwordFingerprint(password)}`;
export function validSession(value: string | false | undefined, password: string) {
  if (!value) return false;
  const [kind, epoch, fp] = value.split(".");
  return kind === "admin" && Number(epoch) === sessionEpoch() && fp === passwordFingerprint(password);
}
