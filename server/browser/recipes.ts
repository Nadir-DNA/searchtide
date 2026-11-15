// Recettes de publication par navigateur (plan D12) : où écrire, sur quoi cliquer, comment reconnaître la preuve.
// Champs repérés par rôle et libellé (jamais par coordonnées), avec des alternatives FR et EN. Une recette « non éprouvée »
// n'a pas encore été validée sur un vrai compte : elle s'arrête en « À vérifier » faute de preuve plutôt que de deviner.
export type Target = { role?: "button" | "textbox" | "link" | "radio" | "menuitem" | "option" | "checkbox"; name?: string; label?: string; css?: string; text?: string };
/** Étape libre, pour les réseaux dont le compositeur ne suit pas l'ordre texte → médias → envoi. */
export type Step =
  | { do: "click"; target: Target[]; optional?: boolean; timeout?: number }
  | { do: "fill"; target: Target[]; value: "text" | "title" | "target"; optional?: boolean }
  | { do: "upload"; target: Target[] }
  | { do: "wait"; ms: number };
export type Recipe = {
  network: string;
  version: number;
  /** Éprouvée sur un vrai compte (date et langue de l'interface), sinon « non éprouvée ». */
  validated: string | null;
  /** Adresse de départ ; celle du compte (web_url) l'emporte si elle est renseignée. */
  entry: string;
  /** Étapes avant l'envoi, dans l'ordre ; remplacent open/title/text/upload quand elles sont données. */
  steps?: Step[];
  /** Le réseau refuse un post sans média (Instagram, TikTok, YouTube, Pinterest). */
  requiresMedia?: boolean;
  /** L'adresse de départ contient {target} : la cible du compte (subreddit) est requise. */
  requiresTarget?: boolean;
  /** Clics avant d'écrire (ouvrir le compositeur). Chaque étape essaie ses alternatives dans l'ordre. */
  open?: Target[][];
  title?: Target[];
  text?: Target[];
  /** Champ fichier pour les médias ; absent = médias non pris en charge par cette recette. */
  upload?: Target[];
  submit: Target[];
  /** Preuve positive : un lien vers la publication, ou l'adresse de la page après l'envoi (`fromUrl`). */
  proof?: { css?: string; attr?: string; mustInclude?: string; fromUrl?: string };
  /** Confirmation visible sans adresse : la publication passe « À vérifier » avec ce message. */
  confirm?: Target[];
  /** Chemins qui signalent une connexion ou une vérification à faire à la main. */
  stopPaths: string[];
  note: string;
};

export const FIXTURE_RECIPE: Recipe = {
  network: "fixture", version: 1, validated: "pages de test locales", entry: "/composer",
  title: [{ label: "Titre" }], text: [{ label: "Texte" }], submit: [{ role: "button", name: "^Publier$" }],
  proof: { css: "[data-post-url]", attr: "data-post-url" },
  stopPaths: ["/login", "/2fa", "/captcha", "/denied"],
  note: "Recette des pages de test.",
};

const RECIPES: Recipe[] = [
  {
    network: "x", version: 1, validated: null, entry: "https://x.com/compose/post",
    text: [{ css: '[data-testid="tweetTextarea_0"]' }, { role: "textbox", name: "Texte du post|Post text|Que se passe-t-il|What is happening" }],
    upload: [{ css: 'input[data-testid="fileInput"]' }, { css: 'input[type="file"]' }],
    submit: [{ css: '[data-testid="tweetButton"]' }, { role: "button", name: "^(Poster|Post|Publier)$" }],
    proof: { css: '[data-testid="toast"] a[href*="/status/"]', attr: "href", mustInclude: "/status/" },
    stopPaths: ["/i/flow/login", "/login", "/account/access", "/i/flow/"],
    note: "X affiche un lien « Voir » vers le post après l'envoi : c'est la preuve.",
  },
  {
    network: "linkedin", version: 1, validated: null, entry: "https://www.linkedin.com/feed/",
    open: [[{ role: "button", name: "Commencer un post|Start a post" }]],
    text: [{ role: "textbox", name: "Éditeur de texte|Text editor|Que voulez-vous|What do you want" }, { css: '.ql-editor[contenteditable="true"]' }],
    submit: [{ role: "button", name: "^(Publier|Post)$" }],
    confirm: [{ css: '[role="alert"]' }, { css: ".artdeco-toast-item" }],
    stopPaths: ["/login", "/checkpoint", "/uas/login", "/authwall"],
    note: "LinkedIn confirme sans donner l'adresse du post : la publication passe « À vérifier », collez son lien pour la marquer publiée.",
  },
  {
    network: "facebook", version: 1, validated: null, entry: "https://www.facebook.com/",
    open: [[{ role: "button", name: "Créer une publication|Create post|Exprimez-vous|What's on your mind" }]],
    text: [{ role: "textbox", name: "Créer une publication|Create a public post|Exprimez-vous|What's on your mind" }, { css: '[role="dialog"] [contenteditable="true"]' }],
    submit: [{ role: "button", name: "^(Publier|Post)$" }],
    stopPaths: ["/login", "/checkpoint", "/two_step_verification"],
    note: "Renseignez l'adresse de la Page dans le compte (web_url) pour publier en son nom. Pas de preuve automatique : « À vérifier ».",
  },
  {
    network: "instagram", version: 1, validated: null, entry: "https://www.instagram.com/", requiresMedia: true,
    steps: [
      { do: "click", target: [{ role: "link", name: "Nouvelle publication|New post|Créer|Create" }, { role: "button", name: "Nouvelle publication|New post|Créer|Create" }] },
      { do: "click", target: [{ role: "link", name: "^(Publication|Post)$" }, { text: "^(Publication|Post)$" }], optional: true, timeout: 3000 },
      { do: "upload", target: [{ css: 'input[type="file"][accept*="image"]' }, { css: 'input[type="file"]' }] },
      { do: "click", target: [{ role: "button", name: "^(Suivant|Next)$" }] },
      { do: "click", target: [{ role: "button", name: "^(Suivant|Next)$" }] },
      { do: "fill", target: [{ role: "textbox", name: "légende|caption" }, { css: '[aria-label*="caption" i][contenteditable="true"]' }], value: "text" },
    ],
    submit: [{ role: "button", name: "^(Partager|Share)$" }],
    confirm: [{ text: "publication a été partagée|post has been shared|Publication partagée|Post shared" }],
    stopPaths: ["/accounts/login", "/challenge", "/accounts/suspended"],
    note: "Instagram confirme sans donner l'adresse : « À vérifier », collez le lien. Une image ou une vidéo est obligatoire.",
  },
  {
    network: "tiktok", version: 1, validated: null, entry: "https://www.tiktok.com/tiktokstudio/upload", requiresMedia: true,
    steps: [
      { do: "upload", target: [{ css: 'input[type="file"][accept*="video"]' }, { css: 'input[type="file"]' }] },
      { do: "wait", ms: 4000 },
      { do: "fill", target: [{ css: '.public-DraftEditor-content[contenteditable="true"]' }, { role: "textbox", name: "légende|description|caption" }], value: "text" },
    ],
    submit: [{ css: '[data-e2e="post_video_button"]' }, { role: "button", name: "^(Publier|Post)$" }],
    confirm: [{ text: "vidéo a été publiée|video has been (uploaded|posted)|Gérer vos publications|Manage your posts" }],
    stopPaths: ["/login", "/signup"],
    note: "TikTok traite la vidéo puis confirme sans adresse : « À vérifier », collez le lien.",
  },
  {
    network: "youtube", version: 1, validated: null, entry: "https://studio.youtube.com/", requiresMedia: true,
    steps: [
      { do: "click", target: [{ css: "#create-icon" }, { role: "button", name: "^(Créer|Create)$" }] },
      { do: "click", target: [{ css: "#text-item-0" }, { role: "menuitem", name: "Importer des vidéos|Upload videos" }, { text: "Importer des vidéos|Upload videos" }] },
      { do: "upload", target: [{ css: 'input[type="file"]' }] },
      { do: "fill", target: [{ css: "#title-textarea #textbox" }, { role: "textbox", name: "titre|title" }], value: "title" },
      { do: "fill", target: [{ css: "#description-textarea #textbox" }, { role: "textbox", name: "description" }], value: "text", optional: true },
      { do: "click", target: [{ css: 'tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]' }, { role: "radio", name: "pas conçue pour les enfants|not made for kids" }] },
      { do: "click", target: [{ css: "#next-button" }, { role: "button", name: "^(Suivant|Next)$" }] },
      { do: "click", target: [{ css: "#next-button" }, { role: "button", name: "^(Suivant|Next)$" }] },
      { do: "click", target: [{ css: "#next-button" }, { role: "button", name: "^(Suivant|Next)$" }] },
      { do: "click", target: [{ css: 'tp-yt-paper-radio-button[name="PUBLIC"]' }, { role: "radio", name: "^(Public|Publique)$" }] },
    ],
    submit: [{ css: "#done-button" }, { role: "button", name: "^(Publier|Publish|Enregistrer|Save)$" }],
    proof: { css: 'a[href*="youtu.be/"], a[href*="youtube.com/shorts/"]', attr: "href", mustInclude: "youtu" },
    stopPaths: ["/signin", "/ServiceLogin", "/v3/signin"],
    note: "YouTube Studio affiche le lien de la vidéo après la publication : c'est la preuve. Publiée en « Public ».",
  },
  {
    network: "pinterest", version: 1, validated: null, entry: "https://www.pinterest.com/pin-creation-tool/", requiresMedia: true,
    steps: [
      { do: "upload", target: [{ css: 'input[type="file"]' }] },
      { do: "fill", target: [{ css: "#storyboard-selector-title" }, { role: "textbox", name: "^(Titre|Title)" }], value: "title", optional: true },
      { do: "fill", target: [{ role: "textbox", name: "description" }, { css: '[aria-label*="description" i][contenteditable="true"]' }], value: "text" },
    ],
    submit: [{ role: "button", name: "^(Publier|Publish)$" }, { css: '[data-test-id="storyboard-creation-nav-done"] button' }],
    proof: { css: 'a[href*="/pin/"]', attr: "href", mustInclude: "/pin/" },
    stopPaths: ["/login", "/signup"],
    note: "L'épingle part sur le dernier tableau choisi dans Pinterest. Le lien « Voir » de l'épingle sert de preuve.",
  },
  {
    network: "reddit", version: 1, validated: null, entry: "https://www.reddit.com/r/{target}/submit?type=TEXT", requiresTarget: true,
    steps: [
      { do: "fill", target: [{ role: "textbox", name: "^(Titre|Title)" }, { css: 'textarea[name="title"]' }], value: "title" },
      { do: "fill", target: [{ role: "textbox", name: "corps|body|texte|text" }, { css: 'div[contenteditable="true"]' }], value: "text" },
    ],
    submit: [{ role: "button", name: "^(Publier|Post)$" }, { css: "#inner-post-submit-button" }],
    proof: { fromUrl: "/comments/" },
    stopPaths: ["/login", "/account/login", "/register"],
    note: "Reddit ouvre le post publié : son adresse sert de preuve. Le subreddit est celui réglé sur le compte.",
  },
];

/** Réseaux sans recette, et pourquoi. */
export const NO_RECIPE: Record<string, string> = { gbp: "Google Business Profile se publie depuis la fiche dans la recherche Google : pas de recette fiable, utilisez l'API ou un agent." };

export const recipeFor = (network: string): Recipe | undefined => RECIPES.find((r) => r.network === network);
export const recipes = () => RECIPES.map((r) => ({ network: r.network, version: r.version, validated: r.validated, media: !!r.upload || !!r.steps?.some((s) => s.do === "upload"), requiresMedia: !!r.requiresMedia, note: r.note }));
