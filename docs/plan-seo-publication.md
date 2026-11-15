# Plan de mise à jour — SEO complet et publication façon Postiz

Date : 15 novembre 2026. Base : Searchtide 0.5.0.

Ce document liste toutes les fonctionnalités à ajouter pour couvrir ce que font ChatSEO (SEO) et Postiz (publication) et que Searchtide ne fait pas encore. Il sert de cahier des charges pour la prochaine mise à jour.

## Principes

- **Gratuit d'abord.** Une fonctionnalité qui demande une source payante est une connexion facultative : sans clé, l'écran affiche « — » et le lien pour la connecter, jamais un faux zéro.
- **Pas de scraping de Google.** Récupérer automatiquement les résultats de recherche est contraire aux conditions de Google : ces données passent par un fournisseur.
- **Vos agents d'abord.** Chaque fonctionnalité expose ses outils MCP (lecture, et écriture pour les clés qui en ont le droit). L'IA passe en priorité par l'abonnement de l'utilisateur (Claude, ChatGPT) via MCP ; une clé d'API dans l'app reste facultative.
- **Approbation pour l'irréversible.** Publier sur un CMS, modifier une page ou publier sur un réseau depuis une clé d'agent passe par une approbation, comme la suppression d'un projet aujourd'hui.
- **Licences.** Searchtide est sous MIT. Le code dérivé de Postiz va uniquement dans `server/publishers/providers/` (AGPL-3.0, avec attribution en tête de fichier). Rien d'autre n'est copié de Postiz.

## Ce qui existe déjà (0.5.0)

Search Console (clics, impressions, position, mots-clés en position 4 à 20), PageSpeed (performance, SEO, LCP, CLS), analytics sans cookie dont le trafic venu des IA, KPI comparables entre projets, publication réelle sur LinkedIn, X, Facebook, Instagram, TikTok et YouTube (à valider sur comptes réels), rendez-vous avec Google Agenda et CalDAV, CRM, serveur MCP avec clés bornées par projet et approbations.

Légende — **Coût** : Gratuit (code seulement), Conditions (quota, accès à demander, ou IA de l'utilisateur), Payant (fournisseur de données). **Taille** : estimation, S (quelques jours), M (une à deux semaines), L (plus).

---

## Lot A — SEO gratuit

| # | Fonctionnalité | Ce qu'elle fait | Source | Coût | Taille |
|---|---|---|---|---|---|
| A1 | **Audit technique** | Parcourt le site (Chromium déjà embarqué), relève pages en erreur, redirections, balises manquantes ou en double, liens cassés, pages orphelines, profondeur, poids, canonical, `noindex`. Classe chaque problème par le trafic Search Console de la page. | Le site lui-même + Search Console | Gratuit | L |
| A2 | **Vérificateurs de page** | Pour une adresse : title, meta description, H1, Open Graph, données structurées Schema, robots.txt, sitemap, canonical, hreflang, lisibilité, densité de mots-clés. | La page | Gratuit | M |
| A3 | **Générateurs** | robots.txt et balisage Schema (organisation, produit, article, FAQ, entreprise locale) prêts à copier. | — | Gratuit | S |
| A4 | **Suivi de mots-clés** | Liste de requêtes suivies par projet, courbe de position, alerte de chute, pages qui perdent des clics, titres à réécrire (CTR bas pour la position), cannibalisation (plusieurs pages sur une même requête). | Search Console (déjà stockée) | Gratuit | M |
| A5 | **Indexation** | État d'indexation par page, envoi des pages nouvelles ou modifiées par IndexNow (Bing, Yandex…), lecture de l'état chez Google par l'API d'inspection d'URL, envoi du sitemap. Ne pas promettre une « indexation Google instantanée ». | IndexNow, API Search Console | Conditions (quota quotidien Google) | M |
| A6 | **Analyse du contenu des concurrents** | Pour des adresses concurrentes : structure, longueur, balises, données structurées, comparées à vos pages. | Pages publiques | Gratuit | M |
| A7 | **Google Analytics 4** | Connecteur : sessions, conversions, sources, pour ceux qui ont déjà GA. | API GA4 | Conditions (quotas) | S |
| A8 | **Google Business Profile** | Avis, note, appels, itinéraires, publications locales. | API Google Business Profile | Conditions (accès à demander à Google) | M |
| A9 | **Rapport SEO et marque blanche** | Rapport par projet (PDF ou page partageable) avec votre logo, pour les clients d'une agence. | Données existantes | Gratuit | M |
| A10 | **Équipe** | Plusieurs comptes avec rôles (administrateur, membre), en plus des clés d'agent. | — | Gratuit | M |

**Outils MCP à ajouter** : `seo_audit_run`, `seo_audit_issues`, `page_check`, `keywords_tracked`, `keyword_track`, `indexing_status`, `indexing_submit`, `competitor_compare`.

**Critères d'acceptation communs** : chaque problème relevé dit quoi corriger et pourquoi, avec le trafic concerné ; aucun chiffre sans source ; les écrans passent à 375 px sans défilement horizontal ; les tâches longues (parcours du site) tournent dans l'ordonnanceur existant et apparaissent dans Réglages.

## Lot B — IA et actions

| # | Fonctionnalité | Ce qu'elle fait | Source | Coût | Taille |
|---|---|---|---|---|---|
| B1 | **Plan d'action priorisé** | Les « quick wins » du lot A rangés par gain attendu, dans « À traiter » : quoi créer, corriger, prioriser. Fonctionne sans IA (règles), enrichi par l'IA si disponible. | Lot A | Gratuit | M |
| B2 | **Assistant** | Questions en langage naturel sur vos données (« pourquoi mon trafic baisse ? »). Via MCP avec l'IA de l'utilisateur ; option clé d'API ou modèle local (Ollama) pour l'avoir dans l'app. | MCP existant | Conditions (IA de l'utilisateur) | M |
| B3 | **Briefs et rédaction d'articles** | Brief (mots-clés, plan, questions) puis brouillon d'article, relu par l'utilisateur avant publication. | Search Console + lot A ; IA | Conditions | M |
| B4 | **Publication sur le CMS et corrections appliquées** | Publier un article, réécrire un title ou une meta après validation (« Oui, appliquer la correction »). WordPress d'abord, puis Shopify, Webflow, Ghost. | API des CMS, accès de l'utilisateur | Gratuit | L |
| B5 | **Visibilité dans les IA (GEO)** | Questions types posées régulièrement à ChatGPT, Claude et Gemini : votre site est-il cité, et à côté de qui ? Présenté comme une tendance, les réponses variant d'une fois à l'autre. | API des modèles | Conditions (appels facturés à l'usage, faibles à petit volume) | M |

**Outils MCP** : `seo_actions`, `brief_create`, `cms_publish` et `cms_apply_fix` (avec approbation pour une clé d'agent), `ai_visibility`.

## Lot C — Données SEO payantes, en option

Une seule connexion facultative « Données SEO » (fournisseur payé à l'usage, par exemple DataForSEO ; tarifs à vérifier). Sans clé, rien ne s'affiche à la place.

| # | Fonctionnalité | Ce qu'elle fait | Taille |
|---|---|---|---|
| C1 | **Volume et difficulté des mots-clés** | Recherche de mots-clés avec volume, difficulté, idées associées. | M |
| C2 | **Analyse des résultats Google** | Qui se classe sur une requête, types de résultats, simulateur d'affichage. | M |
| C3 | **Backlinks** | Vos liens et ceux des concurrents, écarts, liens à risque. | M |
| C4 | **Mots-clés des concurrents** | Sur quoi se classent vos concurrents et pas vous. | M |

## Lot D — Publication façon Postiz

| # | Fonctionnalité | Ce qu'elle fait | Coût | Taille |
|---|---|---|---|---|
| D1 | **Plus de réseaux** | Priorité : Threads, Bluesky, Pinterest, Reddit, Mastodon, Google Business Profile, Telegram. Ensuite : Discord, Slack, Medium, Dev.to, Hashnode, Lemmy, Farcaster, Nostr. Un fichier par réseau dans `providers/`. | Gratuit (applications développeur de l'utilisateur) | L |
| D2 | **Variante et aperçu par réseau** | Un même post décliné par réseau (version longue LinkedIn, courte X), aperçu fidèle avant envoi, limites vérifiées par réseau. | Gratuit | M |
| D3 | **Statistiques des réseaux (KPI sociaux)** | Par compte : abonnés, impressions, portée ; par publication : likes, commentaires, partages, taux d'engagement. Enregistrés comme indicateurs du projet : ils arrivent sur le mur, dans les objectifs et le rapport hebdomadaire. | Gratuit (selon ce que chaque réseau expose) | L |
| D4 | **Publications récurrentes** | Republier un contenu à intervalle choisi (tous les 30 jours…) sur les réseaux choisis, chaque occurrence visible et modifiable dans le calendrier. | Gratuit | S |
| D5 | **Publication depuis un flux RSS** | Chaque nouvel article d'un blog ou d'une newsletter crée un brouillon (ou un post programmé, au choix). | Gratuit | S |
| D6 | **Premier commentaire et fils** | Premier commentaire automatique, fils (X, Threads, Bluesky), hashtags par réseau. | Gratuit | M |
| D7 | **Actions sur seuil** | Exemple : à 100 likes, republier ou ajouter un commentaire. Vérifier les règles de chaque réseau avant d'automatiser ; pas de like automatique. | Gratuit | M |
| D8 | **Meilleurs créneaux** | Propose les heures de publication d'après vos propres statistiques (D3). | Gratuit | S |
| D9 | **Liens courts suivis** | Lien court par publication, clics comptés par l'analytics de Searchtide, avec paramètres UTM. | Gratuit | S |
| D10 | **Webhooks sortants** | Événements (publiée, échec, à vérifier) envoyés vers n8n, un CMS ou une CI. | Gratuit | S |
| D11 | **Visuels et vidéos** | Carrousels générés en HTML aux couleurs du projet puis capturés en images (Chromium), vidéos courtes assemblées avec ffmpeg, textes rédigés par l'IA de l'utilisateur via MCP. Découpage d'une vidéo longue en extraits : plus tard. | Gratuit (IA en option) | L |

| D12 | **Repli par le navigateur intégré** | Quand l'API ne peut pas publier, le post part par le navigateur intégré, avec la session de l'utilisateur déjà connecté au réseau. Détail ci-dessous. | Gratuit | L |

**Outils MCP** : `pub_variants`, `social_stats`, `pub_repeat`, `rss_feeds`, `best_slots`, `visual_generate`, et `pub_publish`, qui choisit lui-même la voie (API ou navigateur).

**À garder** : les états, l'idempotence, « À vérifier » et les approbations de la file actuelle s'appliquent à tous les nouveaux réseaux et à D4, D5, D7, D12.

### D12 — Repli par le navigateur intégré

**Objectif** : l'utilisateur, ou ses agents IA, publie sur tous les réseaux où il est connecté, même sans application développeur ou quand l'API refuse.

**Ce qui existe déjà** : le mode « navigateur » d'un compte de publication. Il comprend des recettes déclaratives (champs repérés par leur étiquette, jamais par coordonnées), une approbation liée au contenu exact, un arrêt sur page de connexion, de double authentification ou de CAPTCHA, et une preuve obligatoire. Seule une recette de test existe : aucune recette réelle par réseau.

**À construire** :

1. **Choix automatique de la voie, compte par compte** : l'API si l'application développeur est configurée et le jeton valide, sinon le navigateur.
2. **Repli seulement sur un échec certain, avant tout envoi** : API non configurée, jeton expiré, type de contenu non pris en charge par l'API, accès refusé. Si l'API a peut-être publié (délai dépassé, réponse incomplète), la publication passe en « À vérifier » et ne repart jamais par le navigateur, sinon elle risque d'être publiée deux fois.
3. **Recettes réelles** pour les six réseaux actuels (LinkedIn, X, Facebook, Instagram, TikTok, YouTube), puis pour chaque réseau du D1. Chaque recette est versionnée, testée sur un vrai compte et signalée « à mettre à jour » dès qu'un réseau change son interface.
4. **Agents** : `pub_publish` prend la même voie. Une publication par navigateur demandée par une clé d'agent exige toujours une approbation de l'administrateur.
5. **Reconnexion** : si la session a expiré, la publication passe en « Action requise » et l'utilisateur se reconnecte à la main dans « Connexions navigateur ».
6. **Visibilité** : le journal de chaque publication indique la voie utilisée (API ou navigateur) et la capture de la preuve.

**Garde-fous** (inchangés) : pas de contournement de CAPTCHA ni de double authentification, pas de masquage du navigateur, pas de rafale (plafond quotidien par compte).

**Risques à afficher à l'utilisateur** :

- **Conditions d'utilisation.** La plupart des réseaux interdisent ou restreignent l'automatisation en dehors de leur API officielle. Le repli s'active donc compte par compte, par une case à cocher qui explique le risque de restriction du compte.
- **Fragilité.** Une recette casse quand le réseau change son interface. La publication passe alors en « Échec » ou « À vérifier », jamais en « Publié » sans preuve.

**Variante sans recette** : un agent externe qui pilote le navigateur de l'utilisateur sur son ordinateur (par exemple Claude dans Chrome) lit les brouillons de Searchtide par MCP, publie, puis renvoie l'adresse du post. Searchtide n'a alors aucune recette à maintenir, mais l'ordinateur doit être allumé et l'utilisateur garde la main sur chaque envoi.

---

## Hors périmètre

- L'offre « clé en main » de ChatSEO (un humain qui fait le SEO) : un service, pas un logiciel.
- Récupérer les résultats de Google sans fournisseur.
- Le like automatique.

## Avancement

- **Étape 1 livrée** (branche `claude/youthful-lovelace-rotjbr`) : A2, A3, A4, A5, D2, D3. Les appels aux API de Google, IndexNow et des réseaux sont testés avec des réponses simulées ; à valider sur de vrais comptes.
- Écarts : D2 ne joint pas encore les médias depuis le compositeur (ils s'ajoutent ensuite dans chaque publication) ; D3 ne couvre pas LinkedIn (profil personnel) ni TikTok (autorisation `user.info.stats` non demandée), ni les publications Instagram (identifiant du média non gardé).

## Ordre de livraison proposé

Tout peut sortir dans une seule mise à jour, mais livrer par étapes réduit le risque. Ordre conseillé, du plus utile et gratuit vers le plus coûteux :

1. A4, A5, A2, A3 (mots-clés, indexation, vérificateurs) et D2, D3 (variantes, statistiques sociales).
2. D12 (repli navigateur, recettes des six réseaux actuels), A1 (audit technique), B1 (plan d'action), B4 WordPress, D4, D5, D8, D9, D10.
3. D1 (réseaux prioritaires), D6, D7, B2, B3, B5.
4. A6 à A10, D11, puis le lot C si une source payante est retenue.

## Sources

- ChatSEO : [accueil](https://chatseo.app/fr), [tarifs](https://chatseo.app/fr/tarifs), [audit technique](https://chatseo.app/fr/fonctionnalites/audit-seo-technique), [recherche de mots-clés](https://chatseo.app/fr/fonctionnalites/outil-recherche-mots-cles), [backlinks](https://chatseo.app/fr/fonctionnalites/checker-backlink), [rédaction](https://chatseo.app/fr/fonctionnalites/redaction-seo).
- Postiz : [documentation pour les IA (liste officielle des réseaux et fonctionnalités)](https://postiz.com/llms-full.txt), [guide 2026](https://postiz.com/blog/grow-social-media-presence-fast-postiz-playbook-2026).
- Fonctionnalités relevées sur les pages publiques, sans test des produits.
