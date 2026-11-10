# Notes de version — Searchtide v0.2.2

Version d'ajouts publiée le 10/11/2026. Elle ne change ni la structure de l'instance ni les données existantes ; le volume `/data` est conservé.

## Nouveautés

- **Supabase (lecture seule)** : un neuvième connecteur. Un rôle Postgres dédié suffit (aucune clé d'API, aucune Management API) et quatre fonctions d'agrégat donnent les utilisateurs, les inscriptions par jour, les connectés sur 7 et 30 jours, et la taille de la base. La connexion refuse le port 6543 (pooling en mode transaction), les superutilisateurs et les fonctions manquantes avec un message dédié ; l'adresse directe `db.*.supabase.co` est acceptée avec un avertissement IPv6. Guide : `docs/guides/supabase.md`.

- **Connexion avec Stripe (bêta)** : en plus de la clé restreinte `rk_`, la carte **Connexions** propose un parcours OAuth en trois clics. Le consentement est explicite (le service voit les données Stripe demandées ; Stripe affiche « lecture et écriture » alors que le relais n'émet que des lectures). Le jeton est rangé dans le coffre chiffré, révocable depuis l'instance (**Retirer**) ou depuis le Dashboard Stripe ; la révocation distante supprime la ligne de jeton côté relais et les indicateurs passent en « Source retirée ».

- **Relais Searchtide Connect** (`relay/`, `https://connect.nadirdaoudi.com`) : Worker Cloudflare + base D1, PKCE, `state` signé, codes et jetons à usage unique, liste blanche stricte des objets et paramètres Stripe, webhook `account.application.deauthorized`, quotas par empreinte HMAC d'adresse IP. Le code est public dans le dépôt, et la politique de confidentialité est servie en français et en anglais par `GET /privacy`.

- **Politique de confidentialité du relais** : le service ne conserve pas l'adresse IP en clair ; il enregistre une empreinte non réversible (HMAC avec un secret du Worker), associée à la route, pendant **au plus une heure**, pour limiter les abus.

## Bêta et mode test

La **Connexion avec Stripe** est en **bêta, comptes de test seulement** : le relais n'accepte que des comptes Stripe en mode test tant que le compte plateforme n'est pas activé. La **clé restreinte `rk_` reste la voie recommandée** pour un compte réel : lecture seule garantie par Stripe, aucune donnée ne quitte l'instance, et la clé ne peut pas être utilisée pour écrire.

Le passage en production du relais ne changera que ses secrets et son `client_id`, pas le code des instances ; il fera l'objet d'une version ultérieure, après vérification du compte plateforme.

## Installation et mise à jour

```bash
docker run -d --name searchtide -p 3030:3030 -v searchtide:/data ghcr.io/nadir-dna/searchtide:0.2.2
docker logs searchtide    # mot de passe administrateur généré au premier lancement
```

Depuis 0.2.1 : remplacer l'image et redémarrer. Aucune migration de base n'est nécessaire ; les connexions, projets et historiques sont conservés.

## Réserves connues (prévues pour la v0.2.3)

- **Rotation du secret du webhook** : le secret Stripe n'est pas encore renouvelable sans redéployer le Worker ; la rotation sera automatisée.
- **Comparaison de signature non constante** : le webhook compare les signatures sans temps constant ; une comparaison dédiée est prévue.
- Le relais est déployé en mode test ; le mode production dépend de la vérification du compte plateforme.
- Les tests Postgres et Supabase réels restent ignorés dans la CI (services non configurés).
- Firefox et WebKit ne sont pas couverts par les tests de bout en bout.

## Vérifications de la version

Suite unitaire (relais inclus), vérification des types, construction de l'interface, 23 tests de bout en bout et scan de secrets : tous verts avant publication.
