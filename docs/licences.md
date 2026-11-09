# Dépendances et licences (T28)

Relevé le 09/11/2026 sur `node_modules` (versions verrouillées par `package-lock.json`), avec `npm query ':not(.dev)'` pour séparer l'exécution des outils de développement. 110 paquets installés au total.

**Conclusion : aucune licence incompatible avec une distribution MIT.** L'application n'embarque que des licences permissives ; les seuls copyleft sont des outils de construction, absents de l'image Docker (`npm prune --omit=dev`) et non redistribués.

## Dépendances d'exécution (13 paquets, toutes permissives)

| Paquet | Version | Licence | Portée |
|---|---|---|---|
| @hono/node-server | 2.1.6 | MIT | directe |
| @modelcontextprotocol/core | 2.4.0 | Apache-2.0 | transitive |
| @modelcontextprotocol/server | 2.4.0 | Apache-2.0 | directe |
| hono | 4.13.17 | MIT | directe |
| nodemailer | 10.4.0 | MIT-0 | directe |
| pg | 8.23.1 | MIT | directe |
| pg-cloudflare | 1.4.1 | MIT | transitive |
| pg-connection-string | 2.14.1 | MIT | transitive |
| pg-pool | 3.14.0 | MIT | transitive |
| pgpass | 1.0.5 | MIT | transitive |
| split2 | 4.2.0 | ISC | transitive |
| zod | 4.6.7 | MIT | directe |

Aucun GPL, AGPL, LGPL, SSPL ni licence non commerciale. `MIT-0` (nodemailer) est plus permissive que MIT (pas d'attribution obligatoire). Apache-2.0 est compatible avec une distribution MIT (mention de licence et de brevets à conserver, ce que fait `node_modules` livré).

## Outils de développement (97 paquets, non livrés dans l'image)

| Paquet | Version | Licence |
|---|---|---|
| @fontsource/ibm-plex-mono | 5.3.0 | OFL-1.1 |
| @fontsource/ibm-plex-sans | 5.3.0 | OFL-1.1 |
| @playwright/test | 1.65.0 | Apache-2.0 |
| @tailwindcss/vite | 4.3.5 | MIT |
| @types/node, @types/nodemailer, @types/pg, @types/qrcode, @types/react, @types/react-dom | — | MIT |
| @vitejs/plugin-react | 6.2.1 | MIT |
| concurrently | 9.2.5 | MIT |
| qrcode | 1.5.4 | MIT |
| react, react-dom | 19.3.1 | MIT |
| tailwindcss | 4.3.5 | MIT |
| typescript | 5.9.3 | Apache-2.0 |
| vite | 8.3.6 | MIT |

Tous les autres outils de développement sont MIT (61), ISC (10), Apache-2.0 (4), BSD-3-Clause (1), 0BSD (1) ou MPL-2.0 (3).

### Points d'attention

- **MPL-2.0 — `lightningcss` et ses binaires** (moteur CSS de Tailwind v4). Copyleft **par fichier**, pas par œuvre : il n'impose rien au code de Searchtide, et l'outil n'est pas dans l'image de production. Compatible.
- **OFL-1.1 — polices IBM Plex** (`@fontsource`). Les fichiers de police sont **livrés** dans `web/dist` : leur licence doit accompagner la distribution. Le texte officiel est copié dans `web/public/polices/OFL-IBM-Plex.txt` et donc servi à `/polices/OFL-IBM-Plex.txt` (l'installation actuelle déclare la police « Plex » sans la renommer).
- **Licence du projet** : MIT (fichier `LICENSE`), mention dans le README. Aucune dépendance n'impose de changer cette licence.

## Méthode et limites

- Licences lues dans le champ `license` des `package.json` installés ; ce n'est pas un avis juridique.
- Les licences peuvent changer entre versions : revérifier avant une montée de version majeure (`npm run licences` n'existe pas encore ; la commande utilisée est `npm query ':not(.dev)'` + lecture de `node_modules/*/package.json`).
- Les polices sont la seule œuvre tierce **redistribuée** dans le build, avec sa licence.
