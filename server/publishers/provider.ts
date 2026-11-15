// Contrat d'un fournisseur de publication réel (MIT). Les implémentations par réseau vivent dans providers/ (AGPL-3.0).
export type FailureKind = "auth" | "format" | "quota" | "rate" | "network" | "refused" | "unknown" | "to_verify";
export type PublishResult =
  | { ok: true; url: string }
  /** `pending` : le réseau traite encore (vidéo, conteneur) ; `data` revient tel quel à `poll`. */
  | { ok: false; kind: "pending"; message: string; data: Record<string, unknown> }
  | { ok: false; kind: FailureKind; message: string };

/** Échecs où rien n'a pu être publié : un nouvel essai est sans risque de doublon. */
export const definitive = (r: PublishResult) => !r.ok && r.kind !== "pending" && r.kind !== "to_verify";

export type Tokens = { accessToken: string; refreshToken?: string; expiresAt?: number; accountId: string; name: string };
export type Refreshed = { accessToken: string; refreshToken?: string; expiresAt?: number };

/** Chiffres d'un compte, tels que le réseau les publie. Absent = non fourni (jamais 0 par défaut). */
export type AccountStats = { followers?: number; posts?: number; views?: number };
/** Chiffres d'une publication. */
export type PostStats = { impressions?: number; likes?: number; comments?: number; shares?: number; views?: number };

export type Media = { id: string; mime: string; size: number; kind: "image" | "video"; bytes(): Buffer; publicUrl(): string };
/** `target` : cible propre au compte (subreddit pour Reddit), réglée dans l'écran des comptes. */
export type PostInput = { text: string; title?: string; visibility?: string; media: Media[]; target?: string };

export interface Provider {
  id: string;
  label: string;
  /** Variables d'environnement de l'application développeur (identifiant, secret). */
  env: [string, string];
  /** Plafonds réels du fournisseur (média : 0 tant que les médias ne sont pas pris en charge). */
  limits: { text: number; media: number };
  /** Le réseau télécharge les médias lui-même : PUBLIC_URL en https est requis. */
  needsPublicMedia?: boolean;
  configured(): boolean;
  /** Règles propres au réseau, avant toute mise en file. */
  check?(input: { text: string; title?: string; visibility?: string; media: { mime: string; size: number }[] }): string[];
  authUrl(redirectUri: string, state: string, verifier: string): string;
  /** Un accès peut ouvrir plusieurs comptes (Pages Facebook, comptes Instagram, chaînes YouTube). */
  exchange(code: string, redirectUri: string, verifier: string): Promise<Tokens[]>;
  /** Absent quand le réseau ne délivre pas de jeton de renouvellement : le compte passe alors « à reconnecter ». */
  refresh?(refreshToken: string): Promise<Refreshed>;
  /** Un doute après l'envoi (délai dépassé, 5xx) renvoie `to_verify`, jamais un échec relançable. */
  publish(input: PostInput, accessToken: string, accountId: string): Promise<PublishResult>;
  /** Suite d'un `pending` : lecture d'état, puis geste final quand le réseau est prêt. */
  poll?(data: Record<string, unknown>, accessToken: string, accountId: string): Promise<PublishResult>;
  /** Statistiques du compte, avec les autorisations déjà accordées. Absent quand le réseau ne les fournit pas. */
  stats?(accessToken: string, accountId: string): Promise<AccountStats>;
  /** Statistiques des publications, par adresse publiée (celle gardée comme preuve). */
  postStats?(urls: string[], accessToken: string, accountId: string): Promise<Record<string, PostStats>>;
  /** Pourquoi les statistiques ne sont pas disponibles, quand `stats` est absent. */
  statsUnavailable?: string;
  /** Cible à régler sur le compte avant de publier (ex. le subreddit). */
  target?: { label: string; help: string; pattern: RegExp };
  /** Réponse sous une publication (premier commentaire, partie suivante d'un fil). Renvoie l'adresse de la réponse. */
  reply?(parentUrl: string, text: string, accessToken: string, accountId: string): Promise<PublishResult>;
  /** Les réponses de l'auteur s'affichent en fil sous le post (X) : la suite d'un long texte peut y partir. */
  threads?: boolean;
}

const registry = new Map<string, Provider>();
export const registerProvider = (p: Provider) => { registry.set(p.id, p); };
export const providerFor = (network: string) => registry.get(network);
export const providers = () => [...registry.values()];
