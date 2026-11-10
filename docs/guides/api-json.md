# Connecter une API JSON

**Temps estimé :** ~3 min · **Comptes multiples :** oui · **Lecture seule.**

Searchtide lit **un nombre** dans la réponse JSON d'une URL que vous contrôlez. Le jeton n'est envoyé qu'au **domaine autorisé** : toute autre adresse est refusée avant l'appel.

## Ce que ça débloque

- Tout chiffre exposé par une URL JSON : nombre d'utilisateurs, file d'attente, stock, score interne, etc.

## Avant de commencer

- Une URL **HTTPS** qui renvoie du JSON, sur un domaine que vous maîtrisez (`http://` n'est accepté que pour `localhost`).
- Si l'API exige une authentification : un jeton **en lecture seule**, créé pour cet usage.
- Le chemin du nombre dans le JSON : `stats.users`, `data.0.total`, ou vide si la réponse est un nombre.

## Étapes

1. Dans Searchtide : **Connexions → API JSON → Connecter**.
2. Renseignez le **Domaine autorisé** : `https://api.exemple.com` (origine seule, sans chemin).
3. Facultatif : l'**en-tête du jeton** (`Authorization` par défaut ; Searchtide ajoute « Bearer » devant si le jeton n'a pas déjà un préfixe).
4. Collez le **jeton** si l'API en demande un.
5. **« Tester et enregistrer »** : Searchtide appelle la racine du domaine autorisé. Un code inférieur à 500 vaut succès.
6. Sur un projet : **Sources → Rattacher → API JSON**, saisissez l'**adresse JSON** complète et le **chemin du nombre**, puis choisissez journalier ou niveau.

## Ce que vous voyez après le test

- **Réussite :** « Connecté : {hôte} », puis « {hôte} répond (HTTP {code}). »
- Un 404 à la racine est accepté : c'est l'**origine** qui compte, pas la page d'accueil.
- Une réponse 500 ou plus est refusée : l'API est en erreur, pas votre configuration.

## Erreurs fréquentes

| Message affiché | Cause | Action |
|---|---|---|
| « Le domaine autorisé doit ressembler à `https://api.exemple.com`. » | Valeur sans schéma. | Saisissez l'origine complète, sans chemin ni paramètre. |
| « Le domaine autorisé doit commencer par `https://` (`http://` n'est accepté que pour localhost). » | Adresse en clair. | Passez l'API en HTTPS. |
| « Cette adresse n'est pas sur le domaine autorisé ({origine}) : le jeton ne lui est jamais envoyé. » | L'URL de l'indicateur pointe ailleurs (sous-domaine différent inclus). | Utilisez la même origine, ou créez une connexion pour ce domaine. |
| « L'adresse redirige ailleurs : indiquez l'adresse finale. » | Redirection 3xx. | Donnez l'URL finale, sans redirection. |
| « L'API refuse ce jeton : vérifiez qu'il est complet et actif. » | 401 : jeton absent, expiré ou faux. | Recréez un jeton en lecture seule. |
| « Permission manquante : l'API refuse l'accès à cette adresse avec ce jeton. » | 403 : droits insuffisants. | Accordez la lecture à cette route. |
| « L'API répond avec une erreur {code}. » | 5xx au test. | Corrigez l'API, puis retestez. |
| « La réponse n'est pas du JSON. » | La route renvoie du HTML ou du texte. | Vérifiez l'URL et l'en-tête `Accept: application/json`. |
| « Pas de nombre à « {chemin} ». » | Chemin faux, ou valeur non numérique. | Corrigez le chemin (`a.b.0.c`) ; la valeur doit être un nombre. |
| « Nom d'en-tête invalide. » | L'en-tête contient un espace ou un caractère interdit. | Utilisez un nom simple, par exemple `X-Api-Key`. |

## Limites et sécurité

- **GET uniquement** ; une redirection est refusée pour que le jeton ne parte jamais ailleurs.
- Un seul nombre par indicateur, lu à la racine ou à un chemin. Pas d'agrégation, pas de pagination.
- Le domaine autorisé est une **liste blanche** : le jeton n'est jamais envoyé à un autre hôte.
- Un jeton facultatif : sans jeton, Searchtide n'envoie que `Accept: application/json`.
- L'origine et l'en-tête sont des réglages non secrets ; le jeton est chiffré et jamais réaffiché.
- Pour retirer : « Retirer » dans la carte, puis révoquez le jeton chez vous.

## Liens de ce guide

Aucun lien externe : l'API est la vôtre.
