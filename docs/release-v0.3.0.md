# Notes de version — Searchtide v0.3.0

Non publiée. Le but de cette version : qu'un entrepreneur qui gère plusieurs projets puisse y piloter le plus possible de KPI et de dates, directement, pour faire monter ses chiffres. Les intégrations deviennent des **modules** qu'on active, et le projet devient l'objet central.

## Modules

- Écran **Modules** : ce que chaque module apporte, son état (Inactif, Actif, À reconnecter) et les projets concernés. Activer un module qui dépend d'un service ouvre le tiroir de connexion habituel (test obligatoire).
- Un module s'active pour l'instance, puis **projet par projet** : un projet n'affiche que les onglets, KPI et blocs de ses modules. Désactiver garde les données et les réglages.
- Les modules se connectent aussi **depuis la page d'un projet** (onglet Réglages), sans la quitter.
- Une source absente ne s'affiche plus comme **0** : « — » et « Activer Stripe » (ou Google, Contacts).
- Les agents ne voient que les outils des modules actifs. Ils peuvent activer un module pour un projet si sa connexion existe déjà, jamais créer une connexion.

## KPI et dates

- **Ajouter des KPI** : tout ce que les modules actifs d'un projet savent mesurer, en un clic. Nouveaux KPI d'analytics : visites venues des assistants IA, nombre d'un événement nommé.
- **KPI calculés** : deux à six KPI du même projet combinés (ex. inscriptions ÷ visites, en %). Une division par zéro ou une valeur manquante donne « — », jamais 0.
- **Jalons** : une date à venir avec compte à rebours sur le projet, dans le fil « Aujourd'hui » à partir de J-7, puis un repère sur les courbes une fois passée.
- Fil **« Aujourd'hui »** (nouvel accueil) : pannes, actions proposées par les modules (mots-clés en position 4 à 20 à faire monter, relances), jalons proches, objectifs en retard. Fait, Plus tard, Ignorer.

## Navigation

Menu en rubriques : Aujourd'hui, Tableaux, Projets, Suivi des sites, Modules, Agents, Réglages. Tableaux, Projets et Suivi des sites sont dépliants ; un projet **épinglé** reste visible même quand Projets est replié. Les anciennes adresses (`?view=portfolio`, `?site=…`, `?view=connections`) fonctionnent toujours.

## Technique

- Tâches de fond sous un **ordonnanceur unique** : dernière exécution, durée et erreur dans Réglages et par MCP (`jobs_status`). Trois échecs de suite créent une alerte.
- **Modules privés** : `PLUGINS_DIR`, un fichier `.ts` par module (et ses connecteurs). Guide : [guides/modules-prives.md](guides/modules-prives.md).
- `GOOGLE_SERVICE_ACCOUNT_JSON` (et `PLAY_BUCKET`) est converti en connexion Google au premier démarrage, puis n'est plus lu.

## Mise à jour d'une instance existante

Au premier démarrage, la migration active ce que l'instance utilise déjà : connexions présentes, indicateurs existants, propriétés Search Console, contacts et publications. Elle crée un projet pour chaque site qui n'appartenait à aucun projet. Elle ne s'exécute qu'une fois, dans une transaction.

Avant de mettre à jour une instance de production, vérifiez sur une **copie** de sa base :

```bash
node scripts/verifier-migration.mjs /chemin/vers/copie.db
```

Le script compare chiffres, indicateurs et pages calculés avec `main` puis avec cette version. Il sort en 0 si la seule différence est le passage de 0 à « — » pour une source absente.
