# Refonte de l'expérience utilisateur de Searchtide

Document de travail pour l'agent chargé des correctifs. Écrit le 15 novembre 2026 à partir de la version **0.6.1** (`origin/main`, commit `114f960`), parcourue écran par écran sur une instance de test, et de la lecture du code de `web/src/`.

Objectif : rendre l'application **facile, lisible et simple** sans **perdre aucune fonctionnalité**. Chaque fonction existante doit avoir une place dans la nouvelle organisation (voir la table de correspondance, partie 5).

---

## 0. Règles pour l'agent

1. **Aucune fonction supprimée.** On déplace, on regroupe, on renomme. Si une fonction n'a pas de place dans la table de la partie 5, on s'arrête et on demande.
2. **Les anciennes adresses continuent de marcher.** Les paramètres d'URL actuels (`?view=pubs`, `?view=project&id=…&tab=…`, `?site=…&tab=…`, `?view=connections`, `?view=modules`, etc.) doivent rediriger vers le nouvel emplacement (favoris, liens des e-mails et du rapport hebdomadaire, liens envoyés par les agents IA via MCP).
3. **Un chantier = une branche = une PR.** Ordre conseillé en partie 6. Pas de PR géante.
4. **Avant chaque commit :** `npm run typecheck`, `npm test`, `npm run build`. Pour les chantiers qui touchent la navigation : `npm run e2e`, avec mise à jour des tests e2e dont les libellés changent (sans les affaiblir).
5. **Pas de nouvelle dépendance.** Réutiliser les composants de `web/src/ui.tsx` (`Card`, `Button`, `Segmented`, `Pill`, `Table`, `EmptyBox`, `KpiCard`…), `Sheet` et `Field` de `web/src/modules/shared.tsx`, et les jetons de couleur Tailwind existants (`text-muted`, `bg-raised`, `text-negative`…).
6. **Langue :** interface et commentaires en français, phrases courtes, aucun terme technique interne visible (voir le glossaire, partie 7).
7. **Le serveur ne change pas** sauf mention contraire (chantier C3). Les routes `/api/*` restent identiques.
8. **Vérifier dans le navigateur** chaque écran modifié : ordinateur (1440 px) et téléphone (375 px), thème sombre et clair, aucune erreur dans la console.

---

## 1. Où se trouvent aujourd'hui les KPI, le trafic et le SEO

C'est le premier problème : ces trois sujets sont **éclatés entre 4 à 6 endroits** et une partie est dupliquée.

### 1.1 KPI (indicateurs, chiffres clés)

| Où dans l'interface | Comment on y arrive | Fichier | Contenu |
|---|---|---|---|
| Accueil « Mur » | Logo, « Tous les projets », « Mur » sur téléphone | `wall.tsx` (`WallView`) | Totaux du portefeuille, une tuile par projet (chiffre principal, courbe, six chiffres clés, prochaine action) |
| Portefeuille (tableau) | Bouton « Comparer en tableau » du Mur, ou palette Ctrl K « Projets » | `portefeuille.tsx`, `portfolio.tsx` (`PortfolioView`), route `?view=projects` | Projets côte à côte, score de santé, colonnes au choix, tri, ligne Total. **Absent de la navigation.** |
| Projet → onglet « Vue » | Onglet du projet en haut | `projects.tsx` (`ProjectView`) | Chiffres clés du projet, indicateurs, objectifs, entonnoir, section « Sources » (`sources.tsx`), « Ajouter des KPI » (`KpiCatalogPanel`), séries archivées |
| Projet → onglets « Revenus », « Produit » | Onglets ajoutés par les modules Stripe et Produit | `projects/ProjectTabs.tsx` (`TAB_SOURCES`) | Cartes KPI filtrées par source |
| Pages personnalisées | Menu « Pages » | `dashboard.tsx` (`DashboardView`), route `?view=page` | Grille de blocs (visites par projet, à traiter, pipeline, publications de la semaine…) |
| Réglages → « Score de santé des projets » | Roue dentée | `settings.tsx` (carte ligne 39) | Poids du score de santé et aperçu |
| Rapport de la semaine | Bouton caché au bas de Réglages | `modules/notifications/ReportView.tsx`, route `?view=report` | Rapport hebdomadaire. **Absent de la navigation.** |

### 1.2 Trafic (visites, « navigation » des visiteurs)

| Où | Comment on y arrive | Fichier | Contenu |
|---|---|---|---|
| Site → onglet « Trafic » | Menu « Sites » → un domaine | `App.tsx` (`SiteView`, ligne 533) → `modules/analytics/index.tsx` (`TrafficView`) | Courbe, provenance, pages, sites référents, assistants IA, pays, appareils, campagnes |
| Projet → onglet « Trafic » | Onglet du projet (si le projet a des sites) | `projects/ProjectTabs.tsx` → **le même** `TrafficView`, un bloc par site | Identique au précédent : **doublon** |
| Site → onglet « Installation » | Menu « Sites » → domaine → Installation | `modules/analytics/index.tsx` (`SetupView`, ligne 162) | Script de suivi, réglages du site |
| Pages personnalisées | Menu « Pages » | `dashboard.tsx` | Bloc « Visites par projet » |

### 1.3 SEO (Google, outils SEO, visibilité IA)

| Où | Comment on y arrive | Fichier | Contenu |
|---|---|---|---|
| Site → onglet « Recherche Google » | Menu « Sites » → domaine (onglet présent seulement si Search Console est connecté) | `modules/google/index.tsx` (`SearchView`) + `modules/google/keywords.tsx` (`KeywordsPanel`) | Clics, impressions, positions des mots-clés, « À travailler en priorité », mots-clés, pages |
| Projet → onglet « Recherche » | Onglet ajouté par le module Google | `projects/ProjectTabs.tsx` → **le même** `SearchView` | **Doublon** du précédent |
| Site → onglet « Outils SEO » | Menu « Sites » → domaine → Outils SEO | `seotools.tsx` (`SeoToolsView`) | Vérifier une page, générer un robots.txt, données structurées, indexation, audit technique du site, concurrents (`competitors.tsx`), briefs et articles (`briefs.tsx`), publier un article WordPress |
| Projet → onglet « Visibilité IA » | Onglet du projet | `visibility.tsx` (`VisibilityView`) | Part des réponses d'IA qui citent le projet, concurrents cités |
| PageSpeed | Aucun écran dédié : indicateurs rattachés au projet | `sources.tsx`, `projects.tsx` | Score de vitesse et SEO technique comme KPI |

**Conséquence :** un utilisateur qui cherche « mon SEO » doit savoir qu'il faut passer par **Sites** pour les outils SEO, par le **Projet** pour la visibilité IA, et que la Recherche Google existe aux deux endroits. Les outils SEO (audit, concurrents, briefs) sont invisibles depuis le projet.

---

## 2. Carte actuelle de l'application

### 2.1 Navigation (fichier `web/src/App.tsx`, lignes 195 à 354)

**Ordinateur, ligne 1 :** logo (accueil) · « Tous les projets » (nombre) · un onglet par projet (voyant de fraîcheur) · « + » nouveau projet · « Aller à… Ctrl K » · « Demander » (assistant) · roue dentée (Réglages).

**Ordinateur, ligne 2 :** « À traiter » (badge) · « Contacts »* · « Publications »* · « Rendez-vous »* · menu « Sites » (liste des domaines + « Ajouter un site ») · menu « Pages » (pages personnalisées + « Nouvelle page ») · à droite menu « Plus » : Modules et connexions, Agents IA, Approbations, Navigateur intégré, Démarrage, Thème, Documentation, Déconnexion.
\* seulement si le module est actif.

**Téléphone, barre du bas (lignes 340 à 354) :** « Mur » · « À traiter » · « Contacts » · « Publier » · « Plus » (ouvre un menu plein écran : Rendez-vous, Sites, Pages, Plus).

### 2.2 Écrans mesurés (instance de test, 1440 px)

| Écran | Route | Hauteur | Sections | Contrôles | Verdict |
|---|---|---|---|---|---|
| À traiter | `?view=today` | 1 écran | — | 13 | Clair |
| Accueil (Mur) | aucune | 1 écran | — | 13 | Clair |
| Projet → Vue | `?view=project&id=` | 877 px | 3 | 17 | Correct, mais message « clé de projet » incompréhensible |
| Contacts | `?view=crm` | 1 écran | — | 12 | Clair |
| **Publications** | `?view=pubs` | **3 116 px** | **7** | 44 | Trop chargé |
| Rendez-vous | `?view=rdv` | 1 116 px | 4 | 8 | Correct |
| Rapport | `?view=report` | 1 744 px | — | 1 | Introuvable dans la navigation |
| **Réglages** | `?view=settings` | **3 301 px** (4 814 px sur téléphone) | **12** | 20 | Trop chargé |
| Agents IA | `?view=agents` | 1 014 px | 3 | 11 | Correct |
| Approbations | `?view=approvals` | 1 écran | 2 | 2 | Correct, mais caché dans « Plus » |
| Navigateur | `?view=browser` | 1 écran | 2 | 2 | Correct |
| **Modules** | `?view=modules` | **1 856 px** | 13 cartes | 26 | Doublon avec Connexions |
| **Connexions** | `?view=connections` | **2 398 px** | 18 cartes | 46 | Doublon avec Modules |
| Démarrage | `?view=start` | 1 160 px | 4 étapes | 11 | Bon |

Sur téléphone (375 px) : aucun débordement horizontal. Accessibilité (axe-core) : voir P9.

---

## 3. Problèmes constatés

Chaque problème a un identifiant repris dans les chantiers.

- **P1. Trois noms pour l'accueil.** « Tous les projets » (ordinateur), « Mur » (téléphone), « Vue d'ensemble » (première page personnalisée). Publications s'appelle aussi « Publier » sur téléphone.
- **P2. Deux notions de « projet ».** Le projet (entité avec `id`) et la « clé de projet » (`crm_key`, texte libre) qui relie contacts et publications. Constaté : contacts et publications créés pour « Fieat », la page du projet Fieat ne les montre pas et affiche « Indiquez la clé de projet (ex. « monprojet ») dans « Gérer le projet » ». Le formulaire de contact garde un champ « Projet » en texte libre (`modules/crm/index.tsx` lignes 203 et 468).
- **P3. KPI, trafic et SEO éclatés et dupliqués** (voir partie 1). Trafic et Recherche Google existent à l'identique dans Site et dans Projet ; les outils SEO ne sont que dans Site ; la visibilité IA n'est que dans Projet ; Portefeuille et Rapport ne sont dans aucun menu.
- **P4. Travail quotidien et configuration mélangés.** La page Publications empile, sous le calendrier (`modules/publications/index.tsx` lignes 125 à 130) : comptes de réseaux, statistiques des réseaux, fiche Google Business, automatisations (RSS, webhooks), actions sur seuil, visuels et vidéos. Réglages empile 12 sections hétérogènes.
- **P5. Deux portes pour la même chose.** Modules et Connexions (une seule entrée de menu, deux pages qui se renvoient l'une à l'autre). « Nouvelle publication » et « Plusieurs comptes » : deux formulaires différents pour créer une publication (le premier exige d'enregistrer avant de joindre un média, le second accepte les médias tout de suite). Publications global et onglet Publications de chaque projet.
- **P6. Fiche de publication trop lourde** (`PubSheet`, `modules/publications/index.tsx` ligne 163) : 10 champs à la création, 15 ensuite, 1 600 px de haut. Deux dates (« Date » et « Programmer pour »), deux statuts (« Statut » Idée/Prévue/Publiée et l'état réel Brouillon/Programmé/Publié/Échec…), « Réseau » en texte libre, « Confidentialité (TikTok) » visible pour tous les réseaux, « Lien de la publication » saisi à la main alors que la preuve est remplie automatiquement. « Publier maintenant » et « Programmer » grisés sans explication tant que le brouillon n'est pas enregistré.
- **P7. Blocages enterrés.** « Le module Publications est désactivé : la file ne tourne pas » apparaît vers 1 400 px, sous le formulaire d'ajout de compte. Les comptes à reconnecter et les publications « À vérifier » ne remontent nulle part en haut d'écran.
- **P8. « Plus » cache des écrans importants.** Approbations (une action à faire) et Agents IA sont rangés avec Thème et Déconnexion.
- **P9. Accessibilité.**
  - Contraste insuffisant (axe « serious », 8 nœuds) sur les numéros des jours hors du mois du calendrier : `opacity-40` sur la cellule (`modules/publications/index.tsx` ligne 97).
  - Ordre des titres sauté (axe « moderate ») dans les cartes de Connexions (`h3` sans `h2` parent, `connections.tsx`).
- **P10. Bug : barre du bas sur téléphone.** « Contacts » et « Publier » s'affichent même si les modules Contacts ou Publications sont désactivés (`App.tsx` lignes 341 à 347 : pas de test `crmOn` / `pubsOn`, contrairement à la barre ordinateur).
- **P11. Vocabulaire interne visible.** « API factice », « Transport », « Agent IA (votre ordinateur) », « clé CRM », « Seuil atteint », « utm_campaign » comme en-tête de colonne.

---

## 4. Organisation cible

### 4.1 Principes

1. **Le projet est la porte d'entrée de toute l'analyse.** KPI, trafic, SEO, revenus, produit, contacts et publications d'un projet se trouvent dans ses onglets. Les vues globales (Accueil, Contacts, Publications) montrent tous les projets avec un filtre.
2. **Usage quotidien d'abord, configuration ensuite.** Chaque espace commence par ce qu'on fait tous les jours ; les réglages rares vont dans un onglet « Réglages » ou « Comptes » de cet espace.
3. **Un nom par chose, partout** (ordinateur, téléphone, palette Ctrl K, rapports, e-mails).
4. **Ce qui bloque se voit en haut**, avec le bouton qui débloque.

### 4.2 Navigation cible

**Ordinateur, ligne 1 (inchangée sauf libellé) :** logo · **« Accueil »** (remplace « Tous les projets ») · onglets projets · « + » · « Aller à… » · « Demander » · roue dentée.

**Ordinateur, ligne 2 :**
`Accueil` · `À traiter` (badge) · `Contacts`* · `Publications`* · `Rendez-vous`* · `Rapports` · à droite `Outils` (menu).

- « Sites » et « Pages » sortent de la barre principale :
  - les **sites** se consultent depuis leur **projet** (onglets Trafic et SEO) ; les sites sans projet sont listés sur l'Accueil dans un bloc « Sites sans projet » ; « Ajouter un site » est sur l'Accueil et dans Projet → Réglages ;
  - les **pages personnalisées** deviennent des onglets de **l'Accueil** (« Mur » par défaut, puis chaque page, puis « + Nouvelle page »).
- **« Rapports »** (nouveau, regroupe ce qui était caché) : onglets `Portefeuille` (l'actuel `?view=projects`) · `Rapport de la semaine` (`?view=report`) · `Rapports clients` (l'actuel `ClientReportCard`, en lecture, le réglage reste dans Projet → Réglages).
- **Menu « Outils »** (remplace « Plus ») : `Intégrations` (Modules + Connexions fusionnés) · `Agents IA` · `Navigateur intégré` · `Démarrage` (tant qu'il n'est pas terminé, aussi en carte sur l'Accueil) · séparateur · Thème · Documentation · Déconnexion.
- **Approbations** quitte « Plus » : chaque demande d'approbation devient un élément de **À traiter** ; l'écran complet (demandes + journal de sécurité) reste accessible par Outils → Agents IA → onglet « Approbations ».

\* seulement si le module est actif, **sur ordinateur et sur téléphone** (corrige P10).

**Téléphone, barre du bas :** `Accueil` · `À traiter` · `Contacts`* · `Publications`* · `Menu`. Le menu plein écran reprend exactement la ligne 2 et le menu Outils, dans le même ordre et avec les mêmes noms.

### 4.3 Onglets d'un projet (cible)

`Vue` · `Trafic` · `SEO` · [`Revenus`] · [`Produit`] · [`Contacts`] · [`Publications`] · `Réglages`
(entre crochets : seulement si le module est actif pour le projet, comme aujourd'hui)

- **Vue** : inchangée (chiffres clés, indicateurs, objectifs, entonnoir, sources, ajouter des KPI). Le message « clé de projet » disparaît (chantier C3).
- **Trafic** : `TrafficView` par site du projet, avec un sélecteur de site en haut s'il y en a plusieurs (au lieu d'empiler les sites). Un lien « Installation du suivi » ouvre l'actuel `SetupView` dans un panneau `Sheet`.
- **SEO** (nouveau, regroupe 4 écrans) avec sous-onglets `Segmented` :
  - `Google` : l'actuel `SearchView` + `KeywordsPanel` (si Search Console n'est pas connecté : une carte « Connecter Google » au lieu de masquer l'onglet) ;
  - `Audit` : vérifier une page, audit technique du site, indexation, robots.txt, données structurées (contenu actuel de `SeoToolsView` sauf concurrents, briefs et WordPress) ;
  - `Contenus` : concurrents (`CompetitorsCard`), briefs et articles (`BriefsCard`), publier un article WordPress ;
  - `Visibilité IA` : l'actuel `VisibilityView`.
  Le sélecteur de site s'applique aux sous-onglets Google, Audit et Contenus.
- L'onglet « Recherche » actuel (module Google) et l'onglet « Visibilité IA » actuel sont remplacés par « SEO » ; les anciennes valeurs `tab=recherche` et `tab=ia` redirigent vers `tab=seo&sub=google` et `tab=seo&sub=ia`.

### 4.4 La vue Site (`?site=…`)

Elle reste pour la compatibilité, mais devient un raccourci : si le site appartient à un projet, rediriger `?site=X&tab=traffic` vers `?view=project&id=P&tab=trafic&site=X` (même logique pour `search` → `seo&sub=google`, `outils` → `seo&sub=audit`, `setup` → panneau d'installation). Si le site n'a pas de projet, garder la vue Site actuelle, avec un bandeau « Ce site n'appartient à aucun projet. Rattacher à un projet ».

### 4.5 Publications (cible)

Onglets en haut de la page (`Segmented`, paramètre d'URL `tab`) :

| Onglet | Contenu (composants existants) |
|---|---|
| `Calendrier` (défaut) | Calendrier mensuel et liste mobile, filtres de projet, statistiques du mois. Bouton principal **« Nouvelle publication »** (un seul). |
| `À surveiller` (badge) | Liste des publications en état `failed`, `needs_action`, `to_verify`, `missed`, `processing`, avec l'action adaptée sur chaque ligne (Réessayer, Marquer publiée / Remettre en brouillon, Reconnecter le compte). |
| `Comptes` | `AccountsCard` (comptes réels avec état + comptes de test), `SocialStatsCard`, `GbpCard`. Lien vers Outils → Intégrations pour configurer un réseau. |
| `Automatisations` | `AutomationCard` (flux RSS, webhooks), `RulesCard` (actions sur seuil). |

- `VisualsCard` (visuels et vidéos) quitte la page : il devient un bouton **« Créer un visuel »** dans la fiche de publication, étape « Écrire », qui ouvre le générateur dans un panneau et joint directement les fichiers produits.
- Le message « module Publications désactivé » devient un **bandeau en haut de page** (au-dessus des onglets) avec le bouton « Activer » (lien vers Outils → Intégrations, module Publications).
- Même bandeau si au moins un compte est « À reconnecter » (bouton « Reconnecter ») ou si des publications sont « À vérifier » (bouton « Voir » → onglet À surveiller).
- L'onglet Publications d'un projet affiche la même page, filtrée sur le projet (comportement actuel de `PubsView` avec `project`).

### 4.6 Fiche de publication unique (remplace `PubSheet` et le composeur « Plusieurs comptes »)

Trois blocs dans l'ordre, dans un `Sheet` large :

1. **Écrire**
   - `Titre (pour vous)` ;
   - `Projet` (liste, préremplie avec le projet affiché) ;
   - `Comptes` : cases à cocher des comptes du projet, groupées par réseau (un ou plusieurs ; remplace « Réseau » en texte libre et « Compte de publication ») ;
   - `Texte` avec un compteur **par compte coché** (limite du réseau le plus strict surlignée) ;
   - `Médias` : zone de dépôt **disponible dès la création** (le brouillon est enregistré automatiquement au premier média si besoin) + bouton « Créer un visuel » ;
   - options propres au réseau, affichées **seulement si un compte de ce réseau est coché** : confidentialité (TikTok, YouTube), titre de la vidéo (YouTube), suites et fil (X).
2. **Quand**
   - choix exclusif : `Maintenant` · `Date et heure` · `Brouillon (pas encore de date)` · `Répéter tous les … jours` (option du composeur actuel) ;
   - la date choisie alimente aussi le jour du calendrier (plus de champ « Date » séparé de « Programmer pour ») ;
   - créneaux conseillés (fonction actuelle du composeur) sous le champ date ;
   - un seul bouton principal dont le libellé suit le choix : « Publier maintenant », « Programmer », « Enregistrer le brouillon ».
3. **Suivi** (après création, replié par défaut)
   - état lisible (un seul : voir ci-dessous), lien de preuve, statistiques du post, lien de suivi (`TrackingLink`), tentatives, notes, lien saisi à la main (« Publiée ailleurs ? Collez son adresse »).

**Un seul statut visible.** Supprimer le sélecteur « Statut » (Idée / Prévue / Publiée) de la fiche. L'interface n'affiche que l'état réel (`state`) avec ces libellés : Brouillon, Programmée, En cours, En traitement, Publiée, Échec, Action requise, À vérifier, Manquée, Annulée. Le champ serveur `status` reste et est déduit : `draft`/`cancelled` → `idea`, `scheduled`/`running`/`processing` → `scheduled`, `published` → `published`. Les publications sans compte (blog, newsletter, saisie manuelle) gardent un bouton « Marquer publiée ».

**Boutons désactivés :** jamais grisés sans raison visible. Si une action est impossible, afficher sous le bouton la phrase qui dit pourquoi et comment débloquer (ex. « Cochez au moins un compte »).

Publier sur plusieurs comptes crée une publication par compte (comportement actuel du composeur « Créer les brouillons »), regroupées dans le calendrier par un même titre.

### 4.7 Intégrations (fusion Modules + Connexions)

Une seule page `Outils → Intégrations` (route `?view=integrations`, avec redirection depuis `?view=modules` et `?view=connections`) :

- une carte par **module** (Analytics, Projets et KPI, Pages, Agents IA, Google, Stripe, Produit, PageSpeed, Contacts, Publications, Prospection, Rendez-vous, Notifications) : description, interrupteur Activer/Désactiver, choix des projets concernés, et **dans la même carte** les connexions dont le module a besoin, avec leur état (Connecté / À reconnecter / Non connecté) et le bouton « Connecter » ou « Gérer » (ouvre le `Drawer` existant de `connections.tsx`) ;
- en bas, un bloc « Autres connexions » pour les connecteurs qui ne dépendent d'aucun module (API JSON, WordPress, Intelligence artificielle, Google Analytics 4…) ;
- la carte « Publication sur les réseaux » (comptes OAuth) va dans la carte du module Publications ;
- filtres en haut : `Tous` · `Actifs` · `À reconnecter` · `Non connectés`.

### 4.8 Réglages en onglets

`?view=settings&tab=` avec `Segmented` :

| Onglet | Cartes actuelles de `settings.tsx` |
|---|---|
| `Général` | Instance, Rapport hebdomadaire |
| `Projets` | Score de santé des projets (poids et aperçu) |
| `Équipe` | Équipe (`team.tsx`) |
| `Alertes` | Surveillance, Notifications sur le téléphone |
| `Sécurité` | Sécurité, Sauvegardes |
| `Diagnostic` | État des sources, Diagnostic, Tâches de fond |

### 4.9 À traiter

Ajouter aux éléments actuels (alertes, actions des modules, jalons, objectifs) :
- publications « À vérifier », « Action requise », « Échec » (lien vers la fiche) ;
- comptes de publication et connexions « À reconnecter » ;
- demandes d'approbation des agents (boutons Approuver / Refuser directement sur la ligne).

Le badge compte l'ensemble.

---

## 5. Table de correspondance (aucune fonction perdue)

| Fonction actuelle | Emplacement actuel | Emplacement cible |
|---|---|---|
| Mur (tuiles projets) | Accueil | Accueil → onglet « Mur » |
| Portefeuille (tableau, score de santé) | `?view=projects` (bouton du Mur) | Rapports → Portefeuille (bouton du Mur conservé) |
| Pages personnalisées | Menu Pages | Accueil → un onglet par page, « + Nouvelle page » |
| Rapport de la semaine | Bouton au bas de Réglages | Rapports → Rapport de la semaine |
| Rapport client | Projet → Réglages | Réglage inchangé ; consultation dans Rapports → Rapports clients |
| Chiffres clés, indicateurs, objectifs, entonnoir, sources, ajouter des KPI | Projet → Vue | Projet → Vue (inchangé) |
| Revenus, Produit | Onglets de module du projet | Inchangé |
| Trafic d'un site | Sites → domaine → Trafic **et** Projet → Trafic | Projet → Trafic (sélecteur de site) ; vue Site seulement pour les sites sans projet |
| Installation du script | Sites → domaine → Installation | Projet → Trafic → « Installation du suivi » (panneau) ; Projet → Réglages |
| Recherche Google, mots-clés | Sites → domaine → Recherche Google **et** Projet → Recherche | Projet → SEO → Google |
| Vérifier une page, audit technique, indexation, robots.txt, données structurées | Sites → domaine → Outils SEO | Projet → SEO → Audit |
| Concurrents, briefs et articles, publier sur WordPress | Sites → domaine → Outils SEO | Projet → SEO → Contenus |
| Visibilité IA | Projet → Visibilité IA | Projet → SEO → Visibilité IA |
| Score de santé (poids) | Réglages | Réglages → Projets |
| Calendrier des publications | Publications | Publications → Calendrier |
| Nouvelle publication / Plusieurs comptes | Deux boutons, deux formulaires | Un bouton, une fiche (partie 4.6) |
| Comptes de réseaux, statistiques, Google Business | Bas de Publications | Publications → Comptes |
| Flux RSS, webhooks | Bas de Publications | Publications → Automatisations |
| Actions sur seuil | Bas de Publications | Publications → Automatisations |
| Visuels et vidéos | Bas de Publications | Fiche de publication → « Créer un visuel » |
| Publications à vérifier / en échec | Fiche de chaque publication | Publications → À surveiller, et À traiter |
| Contacts, pipeline, import, e-mails | Contacts | Inchangé (projet choisi dans une liste, chantier C3) |
| Rendez-vous | Rendez-vous | Inchangé |
| Modules | Plus → Modules et connexions | Outils → Intégrations |
| Connexions | Lien depuis Modules | Outils → Intégrations |
| Publication sur les réseaux (OAuth) | Connexions | Outils → Intégrations → carte Publications |
| Agents IA | Plus | Outils → Agents IA |
| Approbations | Plus | À traiter (chaque demande) + Outils → Agents IA → Approbations |
| Navigateur intégré | Plus | Outils → Navigateur intégré |
| Démarrage | Plus | Outils → Démarrage + carte sur l'Accueil tant qu'il n'est pas fini |
| Thème, Documentation, Déconnexion | Plus | Outils (bas du menu) |
| Palette Ctrl K, assistant « Demander » | Barre du haut | Inchangé (mettre à jour les libellés et cibles de la palette, `palette.tsx`) |
| Ajouter un site | Menu Sites | Accueil + Projet → Réglages |

---

## 6. Chantiers, dans l'ordre

Pour chaque chantier : fichiers concernés, changements, critères d'acceptation.

### C1. Correctifs rapides (1 PR, petite)

Corrige P1 (en partie), P9, P10, P11.

- `App.tsx` lignes 341 à 347 : n'afficher « Contacts » et « Publier » dans la barre du bas que si `crmOn` / `pubsOn` (même règle que la barre ordinateur, ligne 213-214).
- Libellés : « Mur » → « Accueil » (barre du bas), « Tous les projets » → « Accueil » (ligne 234, garder le nombre de projets), « Publier » → « Publications » (barre du bas).
- `modules/publications/index.tsx` ligne 97 : remplacer `opacity-40` sur toute la cellule par une couleur de texte plus faible mais conforme (contraste ≥ 4,5:1) sur le seul numéro du jour, par exemple `text-muted` sur un fond `bg-ground`, et garder les pastilles lisibles.
- `connections.tsx` : corriger l'ordre des titres (titre de section `h2` avant les `h3` des cartes, ou passer les titres de carte en `h2`).
- Remplacer le vocabulaire interne (glossaire, partie 7) dans `modules/publications/index.tsx` (« API factice », « Transport », « Agent IA (votre ordinateur) »), `modules/crm/index.tsx` (« clé CRM ») et `modules/analytics/index.tsx` (« utm_campaign » → « Campagne »).

Acceptation : axe-core sans violation « serious » ou « critical » sur Publications et Connexions ; sur téléphone, modules Contacts et Publications désactivés → ils n'apparaissent pas dans la barre du bas.

### C2. Publications (1 à 2 PR)

Corrige P4, P5 (publications), P6, P7. Fichiers : `modules/publications/index.tsx`, `composer.tsx`, `automation.tsx`, `stats.tsx`, `gbp.tsx`, `visuals.tsx`, `modules/shared.tsx`.

1. Onglets `Calendrier` · `À surveiller` · `Comptes` · `Automatisations` (partie 4.5), paramètre d'URL `tab`. Les cartes actuelles sont déplacées, pas réécrites.
2. Bandeau en haut (module désactivé, comptes à reconnecter, publications à vérifier).
3. Fiche unique (partie 4.6) qui remplace `PubSheet` et le composeur « Plusieurs comptes ». Réutiliser la logique existante d'envoi (`/api/publications/:id/queue`, médias, suites) et de création multiple du composeur.
4. Statut unique affiché (`state`), `status` déduit à l'enregistrement.
5. `VisualsCard` ouvert depuis la fiche.

Acceptation :
- la page Publications tient en un écran sur l'onglet Calendrier (1440 × 900) ;
- créer et programmer une publication sur deux comptes se fait en une seule fiche, sans enregistrer d'abord un brouillon, médias compris ;
- aucun champ de date en double, aucun sélecteur « Statut » ;
- la confidentialité n'apparaît que si un compte TikTok ou YouTube est coché ;
- tous les tests existants des publications passent ; nouveaux tests e2e : créer → programmer → annuler ; publication « À vérifier » visible dans À surveiller et dans À traiter.

### C3. Un seul projet (1 PR, serveur + interface)

Corrige P2.

- Contacts et publications choisissent le projet dans une liste (`id` du projet). Remplacer les champs texte « Projet » de `modules/crm/index.tsx` (lignes 203 et 468) par un `select` des projets, comme dans `modules/publications/index.tsx` ligne 280.
- Migration serveur (`server/migrations.ts`, une migration nommée et datée) : pour chaque contact et publication dont `project` vaut un `crm_key` ou un nom de projet existant, réécrire avec l'`id` du projet. Les valeurs qui ne correspondent à aucun projet sont gardées telles quelles et listées dans Réglages → Diagnostic (« Contacts et publications sans projet ») avec un bouton « Rattacher ».
- Les lectures côté serveur acceptent encore `crm_key` en entrée pendant une version (compatibilité des agents MCP et de l'API REST), mais l'interface n'affiche plus jamais la notion de « clé ».
- `projects.tsx` ligne 339 : supprimer le message « Indiquez la clé de projet » ; la carte « Contacts et publications » s'affiche dès qu'il en existe pour le projet.
- Garder `projectKey()` / `keysOf()` de `modules/publications/index.tsx` le temps de la migration, puis les simplifier.

Acceptation : un contact créé avec le projet Fieat apparaît dans Projet Fieat → Contacts sans autre réglage ; base existante migrée sans perte (test de migration avec des données mêlant `id`, `crm_key` et texte libre) ; tests MCP et API inchangés.

### C4. Navigation et analyse par projet (1 à 2 PR)

Corrige P1, P3, P8. Fichiers : `App.tsx`, `projects/ProjectTabs.tsx`, `seotools.tsx`, `modules/google/index.tsx`, `visibility.tsx`, `palette.tsx`, `wall.tsx`, `dashboard.tsx`.

1. Barre ligne 2 et menu « Outils » (partie 4.2) ; barre du bas et menu téléphone alignés.
2. Accueil avec onglets « Mur » + pages personnalisées + « Nouvelle page ». Bloc « Sites sans projet ».
3. Espace « Rapports » : Portefeuille, Rapport de la semaine, Rapports clients.
4. Onglets de projet cibles (partie 4.3), dont le nouvel onglet SEO à quatre sous-onglets ; découper `SeoToolsView` en deux composants (`SeoAuditView`, `SeoContentView`) sans changer leur contenu.
5. Redirections : `?site=…&tab=…` (partie 4.4), `tab=recherche` → `tab=seo&sub=google`, `tab=ia` → `tab=seo&sub=ia`, `?view=projects` → `?view=reports&tab=portefeuille`, `?view=report` → `?view=reports&tab=semaine`.
6. Palette Ctrl K : mêmes libellés et mêmes cibles que la navigation.

Acceptation : depuis un projet, on atteint trafic, Google, audit, concurrents, briefs et visibilité IA sans passer par le menu Sites ; toutes les anciennes URL de la partie 2 ouvrent le bon écran ; libellés identiques sur ordinateur, téléphone et palette.

### C5. Intégrations (1 PR)

Corrige P5 (modules/connexions). Fichiers : `modules/ModulesView.tsx`, `connections.tsx`, `App.tsx`.

- Page unique (partie 4.7), réutilisant `ModulesView` (cartes) et `Drawer` / `useCatalog` de `connections.tsx`.
- Redirections `?view=modules` et `?view=connections` → `?view=integrations` (en gardant `open=` et le retour des autorisations OAuth `?oauth=…&network=…`, qui doit afficher son message sur la nouvelle page).

Acceptation : on active un module et on connecte son service dans la même carte ; les retours OAuth (LinkedIn, X, Stripe, Google) affichent leur message ; aucun connecteur ne disparaît de la liste.

### C6. Réglages en onglets (1 PR)

Partie 4.8. Fichier : `settings.tsx`. Acceptation : chaque onglet tient en un ou deux écrans ; le lien « Voir le rapport de la semaine » pointe vers Rapports.

### C7. À traiter élargi (1 PR)

Partie 4.9. Fichiers : `today.tsx`, `approvals.tsx`, et la source des éléments côté serveur si les publications et approbations n'y sont pas déjà (vérifier `/api/today` avant d'ajouter quoi que ce soit). Acceptation : une publication « À vérifier », un compte à reconnecter et une demande d'approbation apparaissent dans À traiter avec leur action.

---

## 7. Glossaire (un mot par chose, partout)

| Utiliser | Ne plus afficher |
|---|---|
| Accueil | Tous les projets, Mur, Vue d'ensemble (comme nom d'accueil) |
| Publications | Publier (comme nom d'écran) |
| Projet | clé de projet, clé CRM |
| Compte de test | API factice |
| Mode de publication : API / Navigateur | Transport |
| Publication par l'ordinateur de l'agent | Agent IA (votre ordinateur) |
| Campagne | utm_campaign |
| Intégrations | Modules et connexions (comme deux écrans) |
| Outils | Plus |
| Brouillon, Programmée, En cours, En traitement, Publiée, Échec, Action requise, À vérifier, Manquée, Annulée | Idée, Prévue (comme statut affiché) |
| Quand un post atteint… | Seuil atteint |

---

## 8. Vérifications finales (pour chaque PR)

1. `npm run typecheck`, `npm test`, `npm run build`, `npm run e2e` verts.
2. Chaque écran modifié ouvert dans le navigateur à 1440 px et 375 px, thème sombre et clair : pas de débordement horizontal, pas d'erreur console.
3. axe-core (injecté depuis cdnjs, version épinglée) : 0 violation « critical » ou « serious » sur les écrans modifiés.
4. Toutes les anciennes URL de la partie 2.2 ouvrent le bon écran.
5. La table de la partie 5 est relue ligne par ligne : chaque fonction est trouvable à son emplacement cible.

## 9. Limites de cette analyse

- Parcours fait sur une instance de test avec peu de données (2 projets, 2 sites, 3 contacts, 3 publications), sans connexion réelle (Stripe, Google, réseaux sociaux) : les écrans « remplis » (Recherche Google, statistiques des réseaux, revenus) n'ont été vus qu'à vide.
- Non mesurés : performances (LCP, CLS, INP), parcours au clavier seul, lecteurs d'écran, gros volumes (centaines de publications ou contacts).
- Le code a été lu sur `origin/main` au commit `114f960` ; les numéros de ligne peuvent avoir bougé depuis. Rechercher les composants par leur nom avant de modifier.
