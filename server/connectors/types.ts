// Manifeste d'un connecteur : tout ce qu'il faut pour que l'API, le catalogue et les indicateurs fonctionnent sans écran dédié.
// Ajouter un connecteur = un fichier dans server/connectors/ + une ligne dans index.ts + sa fixture de test.

export type FieldType = "text" | "url" | "number" | "select" | "json" | "textarea";
export type Field = {
  key: string;
  label: string;
  type: FieldType;
  /** Secret : stocké chiffré dans `connections.secrets`, jamais renvoyé par l'API (R1, R3). Sinon : `config`. */
  secret?: boolean;
  required?: boolean;
  help?: string;
  placeholder?: string;
  options?: { value: string; label: string }[];
  default?: string;
  /** Valeur proposée automatiquement à la création (sujet ntfy). Modifiable. */
  generate?: "topic";
};

export type Kpi = {
  id: string;
  label: string;
  unit?: string;
  mode: "daily" | "total";
  /** Paramètres demandés au rattachement (URL, package, requête SQL…). */
  params?: Field[];
  backfill?: boolean;
};

/** Indicateur proposé à cocher quand on rattache la connexion à un projet (P6). */
export type Preset = { kpi: string; label: string; params?: Record<string, string> };

export type GuideStep = { text: string; url?: string };

/** Données d'une connexion passées à test() et collect() : réglages non secrets + secrets déchiffrés. */
export type Cfg = { config: Record<string, any>; secrets: Record<string, any>; label?: string };

export type TestResult = {
  ok: boolean;
  /** Libellé détecté chez le fournisseur (nom du compte, base…). */
  label?: string;
  /** Résumé de ce que la connexion voit (P3). */
  detail?: string;
  /** Message d'erreur affiché sous le bouton (P4). Présent si ok est faux. */
  error?: string;
  /** Réussite avec avertissements : la connexion est enregistrée mais le formulaire les affiche. */
  warnings?: string[];
  /** Indice non secret mis à jour (ex. badge test). */
  livemode?: boolean;
  account?: string;
  /** Nature de l'échec, pour fixer le statut (R13) : auth/permission → « à reconnecter ». */
  failure?: FailureKind;
};

export type FailureKind = "auth" | "permission" | "timeout" | "format" | "other";

/** Erreur attendue d'un connecteur, avec sa nature (auth, permission, délai, format). Le message est celui de la table P4. */
export class ConnectorError extends Error {
  kind: FailureKind;
  constructor(kind: FailureKind, message: string) { super(message); this.name = "ConnectorError"; this.kind = kind; }
}

export type SmtpOptions = { host: string; port: number; secure: boolean; requireTLS?: boolean; auth?: { user: string; pass: string } };
export interface Mailer { verify(): Promise<unknown>; sendMail(m: Record<string, any>): Promise<unknown> }
export interface PgClientLike { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>; release(): void }
export interface PgPoolLike { connect(): Promise<PgClientLike>; end(): Promise<void> }

/** Accès réseau injectables : en production ce sont les vrais ; les tests y mettent des simulations. */
export interface Ctx {
  fetch: typeof fetch;
  now(): Date;
  timeoutMs: number;
  smtp(o: SmtpOptions): Mailer;
  pg(url: string): PgPoolLike;
}

export interface Connector {
  id: string;
  name: string;
  /** Fournisseur affiché dans les messages d'erreur (« Stripe refuse cette clé… »). */
  provider: string;
  /** Deux lettres affichées dans la carte (pas de logos en v1). */
  monogram: string;
  description: string;
  category: "revenus" | "seo" | "produit" | "alertes" | "integre";
  /** Durée affichée « ~N min ». */
  minutes: number;
  /** Une seule connexion possible (SMTP, ntfy, PageSpeed). */
  singleton?: boolean;
  /** Carte « Intégré » ou « Toujours disponible » : rien à connecter. */
  builtin?: boolean;
  /** Ce que la connexion débloque, en toutes lettres : seulement des KPI réellement calculés. */
  unlocks: string[];
  fields: Field[];
  guide: GuideStep[];
  /** Où supprimer la clé chez le fournisseur (affiché à la révocation). */
  revokeUrl?: string;
  /** Requêtes non GET autorisées pour lire (échange de jeton, requête de lecture) : `MÉTHODE préfixe-d'URL`. */
  readPosts?: string[];
  /** Effets de bord déclarés, dont c'est la fonction (envoi d'e-mail, publication ntfy). */
  sideEffects?: ("mail" | "notify")[];
  /** Indice non secret affiché à la place de la clé (R3). Ne doit jamais contenir un secret entier. */
  hint(cfg: Cfg): string;
  test(cfg: Cfg, ctx: Ctx): Promise<TestResult>;
  kpis?: Kpi[];
  presets?: Preset[];
  collect?(cfg: Cfg, kpi: Kpi, params: Record<string, any>, day: string | undefined, ctx: Ctx): Promise<number>;
}

/** Version du manifeste sans fonctions, renvoyée par /api/connectors. */
export type PublicManifest = Omit<Connector, "test" | "collect" | "hint" | "readPosts" | "sideEffects"> & { hasKpis: boolean };
