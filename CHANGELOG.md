# Journal des changements

Toutes les versions notables sont consignées ici. Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/).

## [0.2.0] — préparée le 2026-11-09 (non taguée)

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
