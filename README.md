# Searchtide

[![CI](https://github.com/Nadir-DNA/searchtide/actions/workflows/ci.yml/badge.svg)](https://github.com/Nadir-DNA/searchtide/actions/workflows/ci.yml)

**Analytics web et suivi SEO tout-en-un, 100 % gratuit et open source, pilotable par vos agents IA.**

Searchtide réunit dans un seul tableau de bord multi-sites ce qui demande d'habitude trois outils :
les visites (comme Umami ou Plausible), les données Google Search Console (comme un outil SEO payant)
et un serveur MCP pour que Claude, Cursor ou n'importe quel agent lise et analyse vos chiffres.

Aucune API payante : Searchtide utilise votre propre script de suivi et les données officielles de Google,
gratuites pour vos sites.

## Fonctionnalités (v0.1)

- **Visites sans cookie** : visiteurs, pages vues, pages, canaux, référents, pays, appareils, navigateurs,
  campagnes UTM, événements personnalisés. Pas de bannière de consentement nécessaire : l'empreinte anonyme
  change chaque jour et ne permet pas de suivre une personne.
- **Visibilité dans les IA** : visites venant de ChatGPT, Perplexity, Gemini, Copilot, Claude…
- **Google Search Console** : clics, impressions, CTR, position moyenne par mot-clé et par page, historique
  conservé au-delà des 16 mois de Google, synchronisation automatique toutes les 6 heures.
- **Opportunités** : mots-clés en position 4 à 20 avec beaucoup d'impressions, les plus rentables à travailler.
- **Agents** : serveur MCP (`/mcp`) et API REST protégés par clé.
- **Léger** : un seul processus Node, une base SQLite, une image Docker.

## Démo

Une commande, des données fictives, aucune clé :

```bash
docker run -d -p 3030:3030 -e DEMO=1 -v searchtide_demo:/data ghcr.io/nadir-dna/searchtide:0.2.0
```

![Vue d'ensemble de la démonstration](docs/demo.png)

Détails et captures : [docs/demo.md](docs/demo.md).

## Démarrage

```bash
cp .env.example .env   # renseigner ADMIN_PASSWORD et SECRET
docker compose up -d   # http://localhost:3030
```

Sans Docker (Node 22.18 ou plus) :

```bash
npm install && npm run build && npm start
```

Ajoutez un site dans le tableau de bord, puis collez le script dans le `<head>` du site :

```html
<script defer src="https://votre-instance/script.js" data-site="exemple.com"></script>
```

Événements personnalisés : `searchtide("inscription")` en JavaScript, ou l'attribut `data-searchtide="clic-cta"` sur un élément.

**Pays des visiteurs** : lus dans les en-têtes `cf-ipcountry` (Cloudflare), `x-vercel-ip-country` (Vercel)
ou `x-country`. Placez l'instance derrière Cloudflare (gratuit) pour les obtenir.

## Brancher Google Search Console

1. Dans [Google Cloud Console](https://console.cloud.google.com/), créez un projet et activez l'API
   **Google Search Console API**.
2. Créez un **compte de service** et téléchargez sa clé au format JSON.
3. Dans [Search Console](https://search.google.com/search-console), pour chaque site : Paramètres →
   Utilisateurs et autorisations → ajoutez l'email du compte de service (droit « Restreint » suffisant).
4. Renseignez `GOOGLE_SERVICE_ACCOUNT_JSON` avec le chemin du fichier, redémarrez, puis choisissez la
   propriété de chaque site dans l'onglet **Installation**. Le premier import récupère 16 mois d'historique.

   Avec Docker, placez la clé dans `google.json`, mettez `GOOGLE_SERVICE_ACCOUNT_JSON=/secrets/google.json`
   dans `.env` et créez un `docker-compose.override.yml` :

   ```yaml
   services:
     searchtide:
       volumes:
         - ./google.json:/secrets/google.json:ro
   ```

## Sécurité

- **Double authentification** : `npm run 2fa` affiche un QR code à scanner (Google Authenticator, Authy…) et enregistre le secret dans `.env`. Redémarrez : la connexion demande ensuite le code.
- **Essais limités** : 5 échecs de connexion en 15 minutes bloquent l'adresse IP.
- **Clé en lecture seule** : `API_KEY_READ` donne aux agents l'accès aux statistiques sans droit d'écriture.
- **Sauvegardes** : copie cohérente de la base chaque nuit dans `BACKUP_DIR`, 14 jours gardés. `GET /healthz` répond pour la surveillance externe.

## Agents IA (MCP)

Chaque agent reçoit **sa propre clé** dans **Agents IA** (révocable, journalisée). La clé est en **lecture seule par défaut** : décochez « Lecture seule » pour autoriser les écritures. Le serveur MCP parle **Streamable HTTP** sur `/mcp`, avec la clé dans l'en-tête `Authorization`.

```bash
# Claude Code
claude mcp add --scope user --transport http searchtide http://localhost:3030/mcp --header "Authorization: Bearer VOTRE_CLE"
```

Tout autre client MCP « Streamable HTTP » (Codex, OpenCode, Hermes, SDK…) utilise la même URL et le même en-tête :

```json
{ "mcpServers": { "searchtide": { "type": "http", "url": "http://localhost:3030/mcp", "headers": { "Authorization": "Bearer VOTRE_CLE" } } } }
```

**Lecture** : sites, trafic, Search Console et opportunités SEO (`list_sites`, `traffic_stats`, `search_stats`, `seo_opportunities`), projets et indicateurs (`projects_kpis`), scores de santé et portefeuille (`portfolio_overview`, `alerts`), connexions sans secret (`connections_list`), pages (`dashboard_*`), CRM et publications en lecture (`crm_*`, `pubs_list`), journal des agents (`agent_activity`).
**Écriture** (clé non lecture seule uniquement) : `indicator_record`, `sync_search_console`, `crm_save_contact`, `crm_log`, `pubs_save`, `dashboard_create/update/delete`, `widget_add/update/move/remove`.

Aucune clé secrète ni réglage de connexion n'est renvoyé par les outils ; la démonstration anonyme n'a pas accès au MCP. L'API REST accepte la même clé : `GET /api/sites`, `GET /api/sites/{domaine}/traffic?days=28`, `GET /api/sites/{domaine}/search?days=28`, `POST /api/sites/{domaine}/sync`.

## Feuille de route

- **0.2** : crawler d'audit technique, PageSpeed Insights et Core Web Vitals, statut d'indexation des pages.
- **0.3** : Bing Webmaster (mots-clés et backlinks), IndexNow, robots IA, alertes et rapport hebdomadaire.

## Développement

```bash
npm install
npm run dev     # serveur sur :3030, interface Vite sur :5173
npm test
```

## Données, sauvegarde et mot de passe

Le volume `/data` contient la base SQLite, `secret` (clé de chiffrement du coffre) et `admin-password` (mot de passe généré au premier lancement), ces deux derniers en clair et en droits 600. **Sauvegardez tout `/data`** : restaurer la base sans `secret` rend toutes les connexions indéchiffrables. La sauvegarde nocturne inclut la base, `secret` et `admin-password` ; la sauvegarde hors site (`BACKUP_URL`) envoie un **bundle complet** (`searchtide-AAAA-MM-JJ.bundle.json.gz`) qui contient les trois. Restauration : `node scripts/restore-backup.mjs <bundle> /data`, puis redémarrage ; un bundle sans `secret` est signalé, car les connexions seraient illisibles. Ne joignez jamais ce volume ou ce bundle à un ticket ou à une archive de support.

Mot de passe perdu : supprimez `admin-password` puis redémarrez ; une variable `ADMIN_PASSWORD` reste prioritaire.

## Licence

MIT © Nadir DAOUDI. Les dépendances et polices tierces sont toutes sous licence permissive ou OFL-1.1 ; inventaire détaillé : [docs/licences.md](docs/licences.md).
