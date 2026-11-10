# Journal des changements

Toutes les versions notables sont consignées ici. Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/).

## [0.2.1] — 2026-11-10

Version corrective : les saisies manuelles entrent dans le Portefeuille, le score ne récompense plus le vide, les clés d'agent sont en lecture seule par défaut et l'adresse du compte de service Google se copie en un clic.

### Corrigé

- Portefeuille : CA et contacts saisis à la main (rôle dans l'éditeur d'indicateur), sans addition avec Stripe ; priorité Stripe seulement si l'indicateur `revenue`/`new_customers` existe **avec une valeur** ; cellule « saisi ».
- Score : partiel et neutre sous 60 % de couverture brute, libellé « Partiel · N % mesuré », couverture tronquée quand partiel.
- Clés d'agent : `read_only DEFAULT 1` sur base neuve, clés existantes inchangées.
- Google : bouton Copier sur l'adresse du compte de service, avec repli si le presse-papiers est indisponible.

### Documentation

- README, CONTRIBUTING et SECURITY réécrits ; 10 guides dans `docs/guides/` ; modèles d'issue et de discussion.

## [0.2.0] — publiée le 2026-11-10

Cette version transforme Searchtide en produit auto-hébergé complet : brancher ses services dans l'interface, sans fichier de configuration.

### Ajouté

- **Catalogue de connecteurs** (7) : Stripe (clé restreinte `rk_` en lecture seule), SMTP, Gmail par mot de passe d'application, ntfy, Google Search Console + Google Play (compte de service), Postgres en lecture seule, PageSpeed ; plus l'API JSON et la saisie manuelle.
- **Coffre chiffré** : les secrets des connexions sont chiffrés en AES-256-GCM (clé dérivée de `SECRET` par HKDF) et ne sont jamais réaffichés ; rotation de `SECRET` → connexions « à reconnecter », sans perte d'historique.
- **Onboarding en 4 étapes** et section « Sources » des projets : rattachement d'une connexion, indicateurs créés automatiquement, éditeur d'indicateurs avec choix de la connexion.
- **Score de santé par projet** (tendance, objectifs, fiabilité, conversion, action) avec couverture et poids réglables.
- **Vue Portefeuille** : projets côte à côte, colonnes au choix et ordre conservés, tri accessible, totaux qui refusent d'additionner des devises différentes.
- **Installation en une commande** : `SECRET` et `ADMIN_PASSWORD` générés au premier lancement (volume `/data`, droits 600), affichés une fois, stables au redémarrage.
- **Démonstration** `DEMO=1` en une commande, avec données fictives générées (deux sites, 60 jours de visites, Search Console simulée) et captures pour le README.
- **CI GitHub** (types, tests, build, e2e sur chaque PR) et workflow d'image GHCR multi-arch `linux/amd64` + `linux/arm64` au tag.
- **Inventaire des licences** (110 paquets, aucune licence incompatible avec MIT) et licence OFL des polices livrée avec le build.
- **Scan de secrets** de l'arbre et de tout l'historique (`scripts/scan-secrets.sh`), sans afficher de valeur.

### Modifié

- `.env.example` réduit à trois variables (`SECRET`, `ADMIN_PASSWORD`, `PUBLIC_URL`) ; toutes les clés de service passent par l'écran « Connexions ».
- `docker-compose.yml` démarre sans `.env`, avec vérification de santé, et accepte l'image publiée (`SEARCHTIDE_IMAGE`).
- README : badge CI, démonstration, licence détaillée.

### Corrigé

- Les réglages non secrets ne sont plus renvoyés à une clé d'API ni à un agent MCP, et la démonstration anonyme ne reçoit ni indice ni réglage.
- Une requête SQL Postgres avec un seul point-virgule final est acceptée ; deux instructions restent refusées.
- Le focus reste sur « Annuler » à l'ouverture de la confirmation de retrait d'une connexion (course Chromium de 60 ms).

### Sécurité

- 14 chaînes Stripe factices qui ressemblaient à de vraies clés ont été neutralisées et l'historique local réécrit avant publication.
- `.env` et `google.json` ne sont ni suivis ni présents dans l'historique Git.

### Limites connues

- Fournisseurs réels non testés en recette à ce stade (Stripe, Google, SMTP, ntfy, PageSpeed) : tests et démonstration utilisent des simulations.
- L'image GHCR n'est pas publiée et la version n'est pas taguée : opérations réservées à Nadir après le push.
- Firefox et WebKit ne sont pas couverts par les tests de bout en bout (Chromium seul).

## [0.1.0]

Première version : analytics sans cookie, Google Search Console, opportunités SEO, serveur MCP.
