// Jeton d'accès d'un compte de publication réel : lu dans le coffre, renouvelé avant l'échéance (MIT).
import { db } from "../db.ts";
import { getConnection, getSecrets, markStatus, setSecrets } from "../connections.ts";
import { providerFor } from "./provider.ts";

type Row = Record<string, any>;
const MARGIN = 5 * 60_000;

/** Le compte n'est plus utilisable : la connexion et le compte de publication demandent une reconnexion. */
export function expireAccount(connectionId: string, message: string) {
  markStatus(connectionId, "reconnect", message, false);
  db.prepare("UPDATE pub_accounts SET status = 'expired' WHERE connection_id = ?").run(connectionId);
}

export async function credentialsFor(account: Row): Promise<{ ok: true; token: string; accountId: string } | { ok: false; message: string }> {
  const conn = getConnection(String(account.connection_id));
  const provider = providerFor(String(account.network));
  if (!conn || !provider) return { ok: false, message: "Connexion de publication introuvable" };
  try {
    const s = getSecrets(conn.id);
    if (!s.expires_at || Number(s.expires_at) - Date.now() > MARGIN) return { ok: true, token: String(s.access_token), accountId: conn.account };
    if (!s.refresh_token || !provider.refresh) { expireAccount(conn.id, "Jeton expiré : reconnectez le compte"); return { ok: false, message: "Jeton expiré : reconnectez le compte" }; }
    const t = await provider.refresh(String(s.refresh_token));
    setSecrets(conn.id, { access_token: t.accessToken, refresh_token: t.refreshToken ?? s.refresh_token, expires_at: t.expiresAt ?? null });
    return { ok: true, token: t.accessToken, accountId: conn.account };
  } catch (e) {
    expireAccount(conn.id, "Renouvellement impossible : reconnectez le compte");
    return { ok: false, message: (e as Error).message };
  }
}
