# Searchtide 0.3 : les modules

Statut : cadrage, à valider avant le plan d'implémentation.
Base : revue du 10 novembre 2026 (audit UX en conditions réelles), code de la v0.2.3.

## 1. Intention

**But fixé par Nadir :** un entrepreneur qui gère plusieurs projets doit pouvoir piloter dans Searchtide le plus possible de KPI et de dates, directement, pour faire monter ses chiffres.

Trois choses en découlent :

1. **Plus de KPI, sans effort.** Brancher un service doit faire apparaître ses chiffres là où on les attend : sur le projet, dans les pages, chez les agents. Aujourd'hui, brancher un service ne dit pas où vont ses chiffres, et des blocs affichent 0 pour des services absents.
2. **Les dates comptent autant que les chiffres.** Un lancement, une échéance, une publication ou une mise en ligne expliquent les courbes et rythment le travail.
3. **Piloter, pas seulement regarder.** Chaque KPI peut avoir un objectif, et chaque module peut proposer des actions qui font monter ses chiffres (mots-clés à travailler, relances à faire). Tout arrive dans un seul fil : « Aujourd'hui ».

Interprétation à confirmer : « dates » couvre deux choses, les dates clés (jalons à venir, événements passés) et les données au sens large. Les deux sont traitées ici.

## 2. Objectifs, non-objectifs, anti-objectifs

**Objectifs**

- Le **projet** devient l'objet central. On ne passe plus par « Sites » pour voir un projet.
- Chaque intégration devient un **module** qu'on active pour l'instance, puis projet par projet. Un module actif apporte ses KPI, ses onglets, ses blocs de page, ses outils MCP et ses tâches de fond. Désactivé, tout cela disparaît.
- Un **catalogue de KPI par projet** : tous les KPI que les modules actifs savent produire, ajoutables en un clic, plus les KPI saisis à la main et les **KPI calculés** (un ratio ou une somme d'autres KPI).
- Des **jalons** : des dates à venir avec compte à rebours, et des événements passés qui annotent les courbes.
- Un fil **Aujourd'hui** qui regroupe alertes, actions proposées par les modules et échéances proches, avec Fait, Plus tard et Ignorer.
- **Cockpit cesse d'être un fork** : c'est Searchtide plus un dossier de modules privés.

**Non-objectifs (0.3)**

- Modules écrits par des tiers, place de marché, paiement. Décision prise avec le skill connector-marketplace-strategy : aucune des quatre conditions n'est réunie (pas de demande mesurée, pas de développeurs extérieurs, pas de demandes d'intégration sur mesure, projet solo). Le sujet sera revu si un tiers propose un connecteur ou si des utilisateurs en demandent.
- Plusieurs utilisateurs ou des rôles.
- Droits par module pour les clés d'agent (prévu ensuite, voir §9).
- Interface en anglais (chantier séparé).

**Anti-objectifs : échec même si « ça marche »**

- Un chiffre affiché alors qu'il n'est pas mesuré : un 0 qui veut dire « non branché ».
- Des données existantes perdues ou cassées pendant la migration (sites, indicateurs, Search Console, pages, données de Cockpit).
- Un agent qui peut lire un secret ou créer une connexion.
- Plus d'entrées dans le menu qu'aujourd'hui.

## 3. Contraintes

- Même pile : Node 22 avec le type-stripping natif, Hono, `node:sqlite`, React 19, Vite, Tailwind v4, MCP sans état. **Aucune nouvelle dépendance.**
- Les connecteurs existants (`server/connectors/*`, `contract.ts`, le coffre chiffré) restent la couche d'accès aux données. Les modules s'appuient dessus, sans les remplacer.
- Migrations avec `migrate()` (`server/migrations.ts`), toujours additives. On ne supprime aucune colonne en 0.3.
- Tous les tests existants (215 tests unitaires, 10 parcours e2e) restent verts. Chaque comportement nouveau a son test.
- La migration est testée sur une copie de la base de Cockpit avant toute mise en ligne.

## 4. Ce qu'est un module

Un module regroupe tout ce qu'une capacité ajoute au produit. Ce n'est pas un connecteur : un module peut utiliser zéro connecteur (le CRM), un seul (Stripe) ou plusieurs (Produit : Postgres, Supabase, API JSON).

```ts
// server/modules/types.ts
export interface Module {
  id: string;                         // "google", "stripe", "crm"…
  name: string;
  description: string;                // ce que l'utilisateur obtient, en toutes lettres
  category: "trafic" | "referencement" | "revenus" | "produit" | "commercial" | "notifications";
  core?: boolean;                     // toujours actif, non désactivable
  scope: "instance" | "projet";       // projet : s'active projet par projet
  connectors?: string[];              // connecteurs dont il dépend (ids du registre)
  projectSettings?: Field[];          // réglages par projet (propriété Search Console, compte Stripe…)
  kpis?: (ctx) => KpiOffer[];         // KPI ajoutables au catalogue d'un projet
  tabs?: { id: string; label: string }[];             // onglets ajoutés à la page projet
  widgets?: Record<string, WidgetDef>;                 // blocs ajoutés au catalogue des pages
  actions?: (project, ctx) => Promise<Action[]>;       // propositions pour le fil Aujourd'hui
  routes?: (app: Hono) => void;       // routes REST du module
  mcp?: (server: McpServer, o: { readOnly: boolean }) => void;
  jobs?: { id: string; every: string; run: () => Promise<void> }[];
  verified?: string;                  // date du dernier passage sur un vrai compte
}
```

L'interface charge, pour chaque module, une vue par onglet et un composant par bloc depuis `web/src/modules/<id>/`. Un registre côté client (`web/src/modules/index.ts`) relie un `id` d'onglet ou de bloc à son composant.

### Découpage des modules en 0.3

| Module | Cœur | Portée | S'appuie sur | Apporte |
|---|---|---|---|---|
| Analytics | oui | projet | script de suivi | onglet Trafic, blocs visites, KPI visites, pages vues, événements, part venue des IA |
| Projets et KPI | oui | — | saisie manuelle, KPI calculés | catalogue de KPI, objectifs, entonnoir, jalons |
| Pages | oui | — | — | pages personnalisables |
| Agents | oui | — | — | clés, journal, MCP |
| Google | non | projet | connecteur `google` | onglet Recherche, blocs mots-clés et opportunités, KPI clics, impressions, position, installations Play ; actions « mots-clés à faire monter » |
| Stripe | non | projet | connecteur `stripe` | onglet Revenus, KPI CA net, MRR, abonnements, nouveaux clients |
| Produit | non | projet | `postgres`, `supabase`, `jsonapi` | onglet Produit, KPI en SQL, modèles inscriptions, activation, rétention |
| PageSpeed | non | projet | connecteur `pagespeed` | KPI score de performance, score SEO, LCP, CLS ; action quand un score baisse |
| CRM | non | projet | — | onglet Contacts, blocs pipeline, KPI nouveaux contacts et gagné ; actions « relances à faire » |
| Publications | non | projet | — | calendrier, bloc de la semaine, publications publiées affichées sur les courbes (comme aujourd'hui) |
| Prospection | non | instance | connecteur `smtp` ; nécessite CRM | modèles, séquences, désinscription |
| Notifications | non | instance | `smtp`, `ntfy` | rapport hebdomadaire, alertes |

Le connecteur `manual` et les KPI calculés font partie du module cœur « Projets et KPI ». Sur une instance neuve, seuls les modules cœur sont actifs. Sur une instance existante, la migration active ce qui est déjà utilisé (§8).

## 5. Comportement

### 5.1 Activer un module

- Écran **Modules** (remplace « Connexions » dans le menu) : une carte par module avec son état (Inactif, Actif, À reconnecter), ce qu'il apporte en toutes lettres, et le nombre de projets concernés.
- Activer un module qui dépend d'un connecteur ouvre le tiroir de connexion existant (`Drawer`, test obligatoire avant d'enregistrer). Le tiroir est réutilisé tel quel.
- Une fois connecté, l'écran propose de choisir les projets concernés (cases à cocher), avec les réglages par projet (propriété Search Console, compte Stripe d'une clé d'organisation).
- On peut aussi activer un module **depuis la page d'un projet** : la connexion se fait dans un tiroir, sans quitter le projet. Cela corrige l'impasse relevée par l'audit.
- La désactivation masque tout ce que le module ajoute mais **conserve** les données et la connexion. Une réactivation retrouve tout. Supprimer la connexion reste une action distincte, avec sa confirmation actuelle.

### 5.2 Un bloc ou un KPI dont le module est inactif

- Un bloc de page dont le module est inactif, sur l'instance ou pour le projet concerné, affiche « Activer Stripe pour voir le chiffre d'affaires », avec un bouton. Jamais une valeur.
- Les tuiles de chiffres affichent « — » et la même invitation pour une source absente. Le tableau des projets fait déjà ainsi.
- Le catalogue de blocs montre les blocs des modules inactifs en grisé, avec « nécessite Google ».

### 5.3 Catalogue de KPI d'un projet

- Sur un projet : « Ajouter des KPI » liste tout ce que les modules actifs du projet savent produire, groupé par module, avec une case à cocher. Cela réutilise `presets` et `toIndicator` des connecteurs, ainsi que `POST /api/projects/:id/sources`.
- **KPI calculé** : une nouvelle source `formula` combine deux KPI ou plus du même projet par `+ − × ÷` (ex. taux de conversion = inscriptions ÷ visites × 100). Les valeurs sont calculées jour par jour à partir de `metrics`, sans appel extérieur. Une division par zéro donne une valeur absente, pas zéro.
- Chaque KPI garde ses réglages actuels : objectif, période, unité, place dans l'entonnoir.

### 5.4 Jalons

- Existant : `annotations()` (`server/projects.ts`) fusionne déjà, à la lecture, les notes de la table `annotations` (`kind: "note"`) et les publications publiées du projet (`kind: "publication"`). La page projet les affiche.
- La table `annotations` reçoit `milestone` (0 ou 1) et `source` (`manuel` | `agent` | id de module). L'API ajoute `kind: "jalon"` pour une note marquée `milestone` dont la date est à venir. Les publications restent fusionnées à la lecture, sans copie en base.
- Un **jalon** est une date à venir (lancement, échéance, fin d'une offre). Il est affiché avec un compte à rebours sur le projet et dans le fil Aujourd'hui à partir de J-7. Une fois la date passée, il s'affiche comme une note sur les courbes.
- Une **note** est un trait vertical sur toutes les courbes du projet, ou de tous les projets si `project_id` est NULL.
- Les agents peuvent créer jalons et notes par MCP (`source: "agent"`).

### 5.5 Fil « Aujourd'hui »

- Nouvelle entrée de menu, en premier. Elle regroupe :
  - les alertes existantes (`portfolio.ts`) ;
  - les **actions** proposées par les modules actifs ;
  - les jalons à J-7 ou moins ;
  - les objectifs en retard au rythme actuel.
- Chaque ligne indique le projet, la raison, et le chiffre qu'elle peut faire monter. Elle propose Fait, Plus tard (reportée à demain) et Ignorer (masquée pour cette raison et ce projet tant que la situation ne change pas).
- L'état des lignes est conservé côté serveur (table `today_items`), pour que les agents voient la même chose.
- Le bloc « À traiter » des pages devient une vue de ce fil.

### 5.6 Navigation

```
Aujourd'hui
Tableaux        (pages personnalisables ; « Nouvelle page »)
Projets         (liste ; puis chaque projet avec ses onglets selon ses modules)
Modules
Agents
Réglages        (sécurité, sauvegardes, notifications, tâches de fond, rapport hebdo)
```

- Page projet : onglets **Vue** (KPI, objectifs, jalons, entonnoir), **Trafic**, puis un onglet par module actif sur le projet (Recherche, Revenus, Produit, Contacts), puis **Réglages du projet** (domaines, script de suivi, modules du projet).
- La liste des sites disparaît du menu. La page d'un site devient l'onglet Trafic du projet. Le script de suivi va dans les réglages du projet.
- Le Portefeuille devient la vue « Tous les projets » de la rubrique Projets. Démarrage reste accessible depuis Aujourd'hui tant qu'il n'est pas terminé.
- Le routage reste par paramètres d'URL. Les anciennes URL (`?site=…`, `?view=connections`, `?view=portfolio`) redirigent vers leur nouvel équivalent.

### 5.7 Agents (MCP)

- Le serveur MCP n'enregistre que les outils des modules actifs.
- Nouveaux outils, en lecture : `modules_list` (modules, état, projets concernés), `today` (le fil), `milestones_list`.
- Nouveaux outils, pour les clés en écriture : `module_enable_for_project` et `module_disable_for_project` (seulement pour un module dont la connexion existe déjà), `today_update` (Fait, Plus tard, Ignorer), `milestone_save`, `kpi_add` (depuis le catalogue, KPI calculés compris).
- Interdit à toute clé, et réservé à la session administrateur, comme aujourd'hui : créer, modifier ou supprimer une connexion ; activer un module pour toute l'instance quand cela exige une connexion ; créer une clé d'agent.
- Chaque changement fait par un agent est inscrit au journal des agents.

### 5.8 Tâches de fond

- Une table `jobs` (`id`, `module`, `every`, `last_run`, `duration_ms`, `ok`, `error`) et un ordonnanceur unique, qui remplace les `setInterval` dispersés (index.ts, ops.ts, report.ts, outreach.ts).
- Seules les tâches des modules actifs tournent.
- Visible dans Réglages → Tâches de fond, et lisible par l'outil MCP `jobs_status`. Un échec répété (trois fois de suite) crée une alerte dans le fil Aujourd'hui.

### 5.9 Cockpit

- Au démarrage, Searchtide charge les modules de `PLUGINS_DIR` s'il est défini. Chaque fichier `*.ts` y appelle `registerModule()`.
- Cockpit garde ses spécificités (Stripe par clé d'organisation, comptes de l'organisation, sources Planity et Fund Road, Worker de veille) dans ce dossier privé, et reprend le reste de Searchtide sans le modifier.
- Le dossier n'est jamais publié et n'est pas dans le dépôt Searchtide. Les modules privés passent le même test de contrat que les autres.

## 6. Données

Migrations additives :

```sql
CREATE TABLE modules (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, settings TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL);
CREATE TABLE project_modules (project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, module_id TEXT NOT NULL,
  settings TEXT NOT NULL DEFAULT '{}', PRIMARY KEY (project_id, module_id));
ALTER TABLE annotations ADD COLUMN milestone INTEGER NOT NULL DEFAULT 0;
ALTER TABLE annotations ADD COLUMN source TEXT NOT NULL DEFAULT 'manuel';
CREATE TABLE today_items (key TEXT PRIMARY KEY, project_id TEXT, state TEXT NOT NULL, until TEXT, updated_at INTEGER NOT NULL);
CREATE TABLE jobs (id TEXT PRIMARY KEY, module TEXT NOT NULL, every TEXT NOT NULL, last_run INTEGER, duration_ms INTEGER, ok INTEGER, error TEXT);
```

- `today_items.key` est une empreinte stable de la raison (ex. `google:opportunite:<projet>:<mot-clé>`), pour qu'un élément ignoré le reste tant que sa situation ne change pas.
- Les réglages par projet d'un module vont dans `project_modules.settings`. La propriété Search Console y est **recopiée** depuis `sites.gsc_property`, et la colonne est gardée en lecture pour revenir en arrière.
- Les indicateurs existants ne bougent pas : leur `source` et leur `config.connection_id` suffisent à les rattacher à un module.

## 7. Correspondance avec le code actuel

| Aujourd'hui | En 0.3 |
|---|---|
| `server/connectors/*` | inchangés ; chaque module cite ses connecteurs |
| `WIDGETS` dans `dashboards.ts` | réunion des `widgets` des modules actifs |
| `registerBusinessTools`, `registerProjectTools`… dans `mcp.ts` | `mcp()` de chaque module actif |
| `gsc.ts` (connexion, puis `GOOGLE_SERVICE_ACCOUNT_JSON`) | connexion uniquement ; la variable est convertie en connexion au démarrage puis ignorée, avec un message dans le journal |
| `SetupView`, `SearchView`, `TrafficView` dans `App.tsx` | `web/src/modules/analytics/…`, `web/src/modules/google/…` |
| `business.tsx`, `business.ts`, `outreach.ts` | modules `crm`, `publications`, `prospection` |
| `setInterval` dispersés | ordonnanceur et table `jobs` |
| Alertes de `portfolio.ts` | une source du fil Aujourd'hui |

## 8. Migration d'une instance existante

Au premier démarrage en 0.3, dans une transaction :

1. Les modules cœur sont activés.
2. Un module est activé pour l'instance si sa connexion existe ou si ses données sont utilisées : CRM s'il y a des contacts, Publications s'il y a des publications, Google si une connexion Google existe ou si `GOOGLE_SERVICE_ACCOUNT_JSON` est défini.
3. Pour chaque projet, un module est activé si au moins un de ses indicateurs vient de ce module, ou si un des sites du projet a une propriété Search Console (Google), ou si le projet a une `crm_key` (CRM et Publications).
4. Chaque site qui n'appartient à aucun projet reçoit un projet du même nom, pour qu'aucun site ne disparaisse avec la suppression de « Sites » du menu.
5. La migration s'enregistre dans `migrations` et ne repasse jamais. Un rapport de ce qui a été activé est écrit dans le journal du serveur.

Critère : sur une copie de la base de Cockpit, toutes les pages, tous les indicateurs et tous les chiffres de la vue d'ensemble sont identiques avant et après, à part les blocs de modules inactifs qui affichent l'invitation à l'activer au lieu de 0.

## 9. Après la 0.3

Hors de ce cadrage, mais le modèle doit le permettre sans le refaire :

- de nouveaux modules de KPI : newsletter (Brevo, Beehiiv), autres paiements (Lemon Squeezy, Paddle), App Store Connect, YouTube, GitHub, Cloudflare Web Analytics ;
- une surveillance des sites en module (le Worker de veille de Cockpit) ;
- des droits par module pour les clés d'agent ;
- un lien de partage en lecture pour une page ;
- des prompts et ressources MCP (« point du matin », « ce qui a baissé »).

## 10. Mesures de réussite

- Instance neuve : aucun chiffre affiché pour un module inactif (test e2e).
- Suivre un projet complet (domaine, Google, Stripe) se fait depuis la page du projet, sans la quitter (test e2e).
- Menu d'une instance neuve : 6 entrées, contre 11 aujourd'hui.
- Un projet avec Analytics, Google et Stripe propose au moins 12 KPI ajoutables en un clic, sans compter les KPI calculés.
- Cockpit : zéro fichier modifié dans `server/` et `web/src/` par rapport à Searchtide.
- Migration : chiffres identiques avant et après sur une copie de la base de Cockpit.

## 11. Laissé au développeur

- Le découpage exact des fichiers dans `server/modules/` et `web/src/modules/`.
- La forme du registre côté client et le chargement à la demande des vues.
- La syntaxe du champ `every` des tâches (ex. `"6h"`, `"30m"`, `"daily@08:00"`).
- Les textes de l'interface, à condition de nommer ce que l'utilisateur obtient et non la technique.
- L'ordre des étapes de l'implémentation, à condition que chaque étape reste livrable et testée.

## Choix faits par Claude (à vérifier en relisant)

- « Dates » est interprété comme jalons et événements, en plus des données.
- La table `sites` est gardée, puisque les événements de suivi y sont rattachés. Seule sa place dans le menu disparaît, au lieu de fusionner sites et projets en base.
- Les agents peuvent activer un module pour un projet quand la connexion existe déjà, mais jamais créer de connexion.
- Les KPI calculés se limitent aux quatre opérations sur des KPI du même projet.
- Désactiver un module conserve ses données.
- Le CRM reste dans le dépôt public, sous forme de module optionnel inactif par défaut.
