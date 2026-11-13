# Journal des changements

Toutes les versions notables sont consignées ici. Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/).

## [Non publié] — Refonte de l'interface

### Modifié

- **Nouvelle interface « salle de contrôle »** : thème sombre plus contrasté, grands chiffres en chasse fixe, voyants d'état toujours doublés d'un texte, variations avec flèche et signe.
- **Navigation en haut** : un onglet par projet (voyant de fraîcheur des sources), rubriques « À traiter », Contacts, Publications, menus Sites et Pages, menu « Plus » (Modules, Agents, Approbations, Navigateur, thème, déconnexion). Sur mobile : barre du bas.
- **Accueil = mur de projets** : totaux du portefeuille, une tuile par projet (état, chiffre principal, courbe, six chiffres clés, prochaine action), puis « À traiter ». L'ancien fil « Aujourd'hui » reste accessible sous « À traiter ».
- Page d'un projet : bandeau des chiffres clés avec emplacements « Connecter » pour les sources absentes.

### Ajouté

- Nouveaux KPI comparables entre projets (colonnes du tableau et mur) : pages vues, visites venues des IA, impressions Google, taux de clic, montant en négociation, relances à faire, publications publiées. Une mesure sans source n'apparaît pas (jamais de faux zéro).

## [0.4.0] — non publiée

Clés d'agent bornées par projet, actions sensibles soumises à approbation, navigateur intégré et publications. **Les publications sont SIMULÉES** (fournisseur factice) : aucun réseau social réel n'est joint dans cette version, et le navigateur n'a été éprouvé que sur des pages de test. Notes complètes : [docs/release-v0.4.0.md](docs/release-v0.4.0.md).

### Ajouté

- **Rendez-vous** (module) : un lien de réservation public par type de RDV (`/rdv/<identifiant>`), créneaux calculés d'après vos horaires, jours bloqués, préavis et tampon, sans double réservation. Invitation `.ics` au client et à vous, flux iCal d'abonnement, annulation et report par lien personnel, RDV classés par projet, outils MCP.
- **Agenda relié** au module Rendez-vous : **Google Agenda** par le relais Searchtide Connect (occupations lues, RDV écrits, lien Meet créé automatiquement ; le relais ne lit jamais l'agenda et ne garde aucun jeton Google) ou **CalDAV** (iCloud, Nextcloud, Fastmail, Synology) avec un mot de passe d'application. **Google n'est activable qu'une fois l'application Google du relais validée** : voir `relay/README.md`.
- **Portée par projet** des clés d'agent (lecture ou écriture, projet par projet), appliquée de la même façon en REST et en MCP : une cible hors portée répond « Introuvable ». Les outils MCP sont sur liste blanche pour une clé limitée.
- **Approbations** : une clé d'agent ne supprime pas un projet ni un indicateur sans approbation de l'administrateur, à usage unique et liée à la cible. Un instantané de la base est pris avant toute suppression de projet.
- **Navigateur intégré** (option, administrateur seul) : écran « Connexions navigateur » pour se connecter à la main, session scellée dans le coffre. Tout le trafic de Chromium passe par un **proxy sortant filtrant** (adresses privées, métadonnées, redirections, DNS épinglé). Mode recette `BROWSER_FIXTURES=1` : pages de test locales listées dans l'écran.
- **Publications** : comptes, brouillons, programmation, file d'une minute, médias (25 Mo), preuve, états et tentatives lisibles, « À vérifier » résoluble à la main ; transport factice ou navigateur (recette sur pages de test).
- Image Docker avec Chromium en option (`WITH_BROWSER=1`, `docker-compose.browser.yml`), runbook [docs/exploitation.md](docs/exploitation.md).

### Modifié

- **L'image Docker s'exécute en non root** (utilisateur `node`, uid 1000) : un volume `/data` créé par 0.2.x et appartenant à root doit passer par `chown -R 1000:1000` (voir le runbook).
- Éditer le contenu d'une publication programmée est refusé (annulez puis reprogrammez) ; ajouter ou retirer un média d'une publication programmée ou publiée aussi.
- Un compte de publication exige un projet existant. Le port des pages de test n'est admis qu'en mode recette.

### Sécurité

- Corrigés après revue : lecture pouvant écrire par le MCP, filtre d'adresses du navigateur contournable (IPv4 mappée, DNS, redirections), fuite d'un domaine hors portée par un bloc de page, reconnexion et expiration du ticket de vue, session non révoquée à la suppression d'un compte, contrôle d'origine absent à l'envoi de média.
- L'idempotence écrit l'intention avant l'envoi : une intention sans adresse de preuve passe en « À vérifier », jamais rejouée.

## [0.3.0] — non publiée

Les intégrations deviennent des **modules** activables par projet ; le projet devient l'objet central. Notes complètes : [docs/release-v0.3.0.md](docs/release-v0.3.0.md).

### Ajouté

- **Modules** : écran Modules, activation pour l'instance puis projet par projet, connexion depuis la page d'un projet ; outils MCP, blocs, onglets et tâches limités aux modules actifs (`modules_list`, `module_enable_for_project`, `module_disable_for_project`).
- **Catalogue de KPI** d'un projet (`kpi_catalog`, `kpi_add`), nouveaux KPI d'analytics (visites venues des IA, événement nommé) et **KPI calculés** (ratio, somme… de KPI du même projet).
- **Jalons** avec compte à rebours (`milestones_list`, `milestone_save`).
- Fil **« Aujourd'hui »** : alertes, actions proposées par les modules, jalons à 7 jours, objectifs en retard ; Fait, Plus tard, Ignorer (`today`, `today_update`).
- **Tâches de fond** : ordonnanceur unique, état dans Réglages et par MCP (`jobs_status`), alerte après trois échecs consécutifs.
- **Modules privés** chargés depuis `PLUGINS_DIR`.
- Menu par rubriques dépliantes (Tableaux, Projets, Suivi des sites), projets **épinglés** toujours visibles.
- `scripts/verifier-migration.mjs` : compare chiffres, indicateurs et pages avant et après la migration sur une copie de base.

### Modifié

- Une source absente s'affiche « — » avec « Activer … », jamais 0 (chiffre d'affaires, clics, contacts).
- `GOOGLE_SERVICE_ACCOUNT_JSON` est converti en connexion Google au premier démarrage (avec `PLAY_BUCKET`), puis n'est plus lu ; la propriété Search Console devient un réglage du projet.
- Les relances quittent les alertes du portefeuille pour le fil « Aujourd'hui ».
- La carte « Agents IA » d'un site renvoie vers la page Agents (plus de mention d'`API_KEY`).

## [0.2.3] — 2026-11-10

Passage du relais Searchtide Connect en mode réel et remboursement de la dette technique du webhook.

### Ajouté

- Relais en **mode réel** : webhook Connect `livemode`, `client_id` réel, clés `rk_live` (lectures) et `sk_live` (OAuth uniquement) ; le mode test reste disponible par configuration.
- **Rotation du secret du webhook** : plusieurs signatures `v1` acceptées dans un même en-tête (ancien et nouveau secret via `WEBHOOK_SECRET_PREVIOUS`).
- **Mode cohérent (CA59)** : `rk_live_`/`sk_live_` en réel, `rk_test_`/`sk_test_` en test ; sinon `/v1/health`, `/v1/start` et `/oauth/*` répondent 503 « Mode incohérent ».
- **Déploiement sûr (CA60)** : `npm run deploy:relay` refuse un changement de mode non demandé (`--changer-de-mode` pour l'autoriser) et vérifie le mode après déploiement.

### Corrigé

- Signature du webhook comparée **à temps constant**.
- `/v1/revoke` ne répond plus `ok` quand Stripe refuse la désautorisation : **502** explicite, jeton local supprimé, message « retirez l'application dans votre Dashboard Stripe » ; une application déjà retirée est un succès idempotent.
- **Tests** : échecs de « Retirer » (502, injoignable, délai) et contrat entre `stripeMetric` et la liste blanche du relais.

## [0.2.2] — 2026-11-10

Version d'ajouts : un neuvième connecteur, et une **Connexion avec Stripe** en bêta (comptes de test), servie par le relais Searchtide Connect.

### Ajouté

- **Supabase** (lecture seule) : utilisateurs, inscriptions par jour, connectés sur 7/30 jours, taille de la base, par un rôle Postgres dédié et quatre fonctions d'agrégat ; refus du port 6543 et des superutilisateurs, avertissement sur l'adresse directe.
- **Connexion avec Stripe (bêta)** : consentement explicite, OAuth via **Searchtide Connect** (`https://connect.nadirdaoudi.com`), jeton stocké dans le coffre, révocation depuis l'instance ou le Dashboard Stripe. En mode test uniquement tant que le compte plateforme n'est pas activé ; la clé restreinte `rk_` reste la voie recommandée.
- **Relais Searchtide Connect** (dossier `relay/`) : Worker Cloudflare + D1, PKCE, state signé, codes et jetons à usage unique, liste blanche de lectures, webhook `account.application.deauthorized`, quotas par empreinte HMAC d'IP.
- **Politique de confidentialité du relais** (FR/EN, `GET /privacy`) : empreinte d'IP non réversible conservée au plus une heure pour limiter les abus.

### Corrigé

- Repli propre quand le relais est indisponible : message, bouton désactivé, clé limitée accessible au clavier.
- Retirer une connexion OAuth marque les indicateurs « Source retirée » et avertit si la révocation distante échoue.
- MRR identique par clé `rk_` et par relais (`interval_count` et remises conservés).
- Page d'autorisation : hôte réel de `return_url` ; objets Stripe hors liste blanche refusés (`Object.hasOwn`).

### Documentation

- Notes `docs/release-v0.2.2.md`, guides Stripe et FAQ mis à jour (bêta, comptes de test, relais).
- `README.md` et `README.en.md` : Supabase, Connexion avec Stripe en bêta, relais.

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
