// Relevé d'un KPI par une connexion enregistrée : choix de la connexion, déchiffrement à la demande, mise à jour du statut.
import { connections, getConnection, getSecrets, markStatus } from "../connections.ts";
import { get, runCollect, realCtx } from "./registry.ts";
import { ConnectorError, type Ctx } from "./types.ts";

let ctxOverride: Ctx | undefined;
/** Pour les tests : remplace l'accès réseau des relevés. */
export function setCollectContext(ctx?: Ctx) { ctxOverride = ctx; }
/** Accès réseau courant (réel, ou simulé dans les tests). */
export const currentCtx = () => ctxOverride ?? realCtx();

/**
 * Relève `kpi` du connecteur `kind` avec la connexion `connectionId` (ou la première du type).
 * Une erreur d'authentification ou de permission passe la connexion en « à reconnecter » (R13) ; l'erreur est relancée.
 */
export async function collectVia(kind: string, connectionId: string | undefined, kpi: string, params: Record<string, any>, day: string | undefined) {
  const m = get(kind);
  if (!m) throw new Error(`Connecteur inconnu : ${kind}`);
  const conn = connectionId ? getConnection(connectionId) : connections(kind)[0];
  if (!conn || conn.kind !== kind) throw new Error(connectionId ? "Source retirée : la connexion de cet indicateur n'existe plus." : `Aucun compte ${m.name} connecté : ajoutez ${m.name} dans Connexions`);
  const secrets = getSecrets(conn); // VaultError si SECRET a changé
  try {
    return await runCollect(m, { config: conn.config, secrets, label: conn.label }, kpi, params, day, ctxOverride ?? realCtx());
  } catch (e) {
    if (e instanceof ConnectorError && (e.kind === "auth" || e.kind === "permission")) markStatus(conn.id, "reconnect", e.message, false);
    throw e;
  }
}
