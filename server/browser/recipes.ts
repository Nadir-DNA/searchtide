// Recettes de publication par navigateur (plan D12) : où écrire, sur quoi cliquer, comment reconnaître la preuve.
// Champs repérés par rôle et libellé (jamais par coordonnées), avec des alternatives FR et EN. Une recette « non éprouvée »
// n'a pas encore été validée sur un vrai compte : elle s'arrête en « À vérifier » faute de preuve plutôt que de deviner.
export type Target = { role?: "button" | "textbox" | "link"; name?: string; label?: string; css?: string };
export type Recipe = {
  network: string;
  version: number;
  /** Éprouvée sur un vrai compte (date et langue de l'interface), sinon « non éprouvée ». */
  validated: string | null;
  /** Adresse de départ ; celle du compte (web_url) l'emporte si elle est renseignée. */
  entry: string;
  /** Clics avant d'écrire (ouvrir le compositeur). Chaque étape essaie ses alternatives dans l'ordre. */
  open?: Target[][];
  title?: Target[];
  text: Target[];
  /** Champ fichier pour les médias ; absent = médias non pris en charge par cette recette. */
  upload?: Target[];
  submit: Target[];
  /** Preuve positive : un lien vers la publication. */
  proof?: { css: string; attr: string; mustInclude?: string };
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
];

export const recipeFor = (network: string): Recipe | undefined => RECIPES.find((r) => r.network === network);
export const recipes = () => RECIPES.map((r) => ({ network: r.network, version: r.version, validated: r.validated, media: !!r.upload, note: r.note }));
