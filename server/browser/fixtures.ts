// B1 : pages de test contrôlées, servies en boucle locale uniquement. Aucun réseau réel, aucun compte.
// Chaque page reproduit un état utile au moteur : composeur, connexion, double authentification,
// vérification type CAPTCHA, refus d'accès, succès avec ou sans preuve, plantage après le clic final.
import { createServer, type Server } from "node:http";

const page = (title: string, body: string) => `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>${title}</title></head>
<body><main>${body}</main></body></html>`;

const composer = (action: string) => page("Composeur factice", `
  <h1>Composeur factice</h1>
  <form action="${action}" method="get">
    <label>Titre <input name="title" aria-label="Titre" required></label>
    <label>Texte <textarea name="text" aria-label="Texte" required></textarea>
    <button type="submit">Publier</button>
  </form>`);
const COMPOSER = composer("/published");

const PAGES: Record<string, string> = {
  "/composer": COMPOSER,
  "/composer-no-proof": composer("/no-proof"),
  "/composer-crash": composer("/crash-after-click"),
  "/login": page("Connexion factice", `
    <h1>Connexion factice</h1>
    <form action="/composer" method="get">
      <label>Identifiant <input name="user" aria-label="Identifiant" autocomplete="off"></label>
      <label>Mot de passe <input name="pass" type="password" aria-label="Mot de passe" autocomplete="off"></label>
      <button type="submit">Se connecter</button>
    </form>`),
  "/2fa": page("Double authentification factice", `
    <h1>Code de vérification</h1>
    <form action="/composer" method="get">
      <label>Code <input name="code" aria-label="Code de vérification" inputmode="numeric"></label>
      <button type="submit">Valider</button>
    </form>`),
  "/captcha": page("Vérification factice", `
    <h1>Vérification de sécurité</h1>
    <p>Cette vérification doit être faite par la personne.</p>
    <label>Recopiez le code <input name="check" aria-label="Code de vérification"></label>
    <button type="button">Vérifier</button>`),
  "/denied": page("Accès refusé", `<h1>Accès refusé</h1><p>Ce compte n'a pas accès à cette page.</p>`),
  "/published": page("Publication factice", `
    <h1>Publié</h1>
    <p data-post-url="https://exemple.test/posts/1">Adresse de la publication : https://exemple.test/posts/1</p>`),
  "/no-proof": page("Publication factice sans preuve", `<h1>Envoi terminé</h1><p>Aucun signal de succès sur cette page.</p>`),
  "/crash-after-click": page("Plantage après le clic", `<h1>Page perdue</h1><p>La page ne répond plus.</p>`),
};

export type Fixtures = { url: string; port: number; close: () => Promise<void> };

/** Démarre les pages de test sur 127.0.0.1 avec un port éphémère (aucune écoute publique). */
export async function startFixtures(): Promise<Fixtures> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const html = PAGES[path];
    if (!html) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("Page de test inconnue"); return; }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(html);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Pages de test : port indisponible");
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Chemins livrés en B1 (une recette factice les utilise ; les recettes réelles viendront en B5). */
export const FIXTURE_PATHS = Object.keys(PAGES);
