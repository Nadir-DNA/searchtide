// Contrat d'un fournisseur de publication réel (MIT). Les implémentations par réseau vivent dans providers/ (AGPL-3.0).
export type PublishResult =
  | { ok: true; url: string }
  | { ok: false; kind: "auth" | "format" | "quota" | "rate" | "network" | "refused" | "unknown" | "to_verify"; message: string };

export type Tokens = { accessToken: string; refreshToken?: string; expiresAt?: number; accountId: string; name: string };

export interface Provider {
  id: string;
  /** Plafonds réels du fournisseur (média : 0 tant que les médias ne sont pas pris en charge). */
  limits: { text: number; media: number };
  configured(): boolean;
  authUrl(redirectUri: string, state: string): string;
  exchange(code: string, redirectUri: string): Promise<Tokens>;
  /** Absent quand le réseau ne délivre pas de jeton de renouvellement : le compte passe alors « à reconnecter ». */
  refresh?(refreshToken: string): Promise<Tokens>;
  /** `ok:false` seulement si rien n'a pu être publié ; un doute (délai dépassé, 5xx) renvoie `to_verify`. */
  publish(text: string, accessToken: string, accountId: string): Promise<PublishResult>;
}

const registry = new Map<string, Provider>();
export const registerProvider = (p: Provider) => { registry.set(p.id, p); };
export const providerFor = (network: string) => registry.get(network);
