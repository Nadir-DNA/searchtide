# Politique de sécurité

## Signaler une faille

**N'ouvrez pas d'issue publique** et ne publiez pas les détails avant correction.

Utilisez le signalement privé de GitHub : onglet **Security** du dépôt → **Report a vulnerability** (GitHub Security Advisories). Le rapport reste privé entre vous et le mainteneur.

Merci d'inclure, si possible :

- la version concernée (`0.2.0`, image ou commit) ;
- le type de déploiement (Docker, compose, depuis les sources) et s'il est exposé à Internet ;
- les étapes de reproduction, la requête ou l'URL ;
- l'effet observé, et ce qu'un attaquant pourrait obtenir ;
- une preuve minimale (sortie, capture) **sans secret, sans jeton, sans donnée personnelle**.

Vous recevrez un accusé de réception et une évaluation. Ce projet est maintenu sur un temps limité : il n'y a **pas d'engagement de délai**, mais les signalements sont traités avant les autres demandes.

## Connexion : budgets et journal

- L'adresse source est l'adresse TCP, sauf `TRUST_PROXY` explicite (`cloudflare` ou nombre de sauts). Les en-têtes de proxy ne sont jamais lus par défaut.
- Les budgets sont persistés en base : `login` 5 échecs/15 min par IP et 15/15 min toutes sources ; `2fa` 5 par IP et 10 global, séparés. Une clé `Bearer` refusée compte comme un échec de connexion.
- **Compromis assumé :** un attaquant peut bloquer la connexion 15 minutes en saturant le budget global ; c'est préférable à un dictionnaire illimité. Le propriétaire est alerté (journal et « Aujourd'hui »).
- Les événements (`login_lockout`, `login_fail_burst`, activation/désactivation 2FA, purge, création/révocation de clé) sont conservés sans IP ni secret ; les 50 derniers apparaissent dans Diagnostic.
- **Risque résiduel de la collecte publique :** le seau par site autorise environ 120 + 20/s, soit jusqu'à ~1,7 million d'événements par jour et par site ; prévoir la purge ou un seuil plus bas si l'instance est exposée.

## Agents, approbations et navigateur intégré (0.4)

- **Portée** : une clé d'agent limitée à des projets ne lit ni n'écrit hors de sa portée, en REST comme en MCP. Une clé en portée lecture sur un projet n'y écrit par aucun outil. Pour une clé limitée, les outils MCP sont sur liste blanche.
- **Approbations** : supprimer un projet ou un indicateur avec une clé demande l'approbation de l'administrateur, à usage unique, liée à la clé et à la cible. Un instantané de la base est pris avant toute suppression de projet.
- **Navigateur intégré** (option) : administrateur seul. Chromium ne sort que par un proxy local qui résout lui-même les noms, refuse les adresses internes et de métadonnées (y compris par redirection ou IPv4 mappée) et joint l'adresse validée. Le proxy ne déchiffre pas le HTTPS ; en conteneur, ajoutez une règle réseau qui interdit la sortie vers les réseaux privés. Le bac à sable de Chromium reste actif et n'a pas de repli. Ni furtivité ni contournement de CAPTCHA ou de double authentification.
- **Publications** : simulées dans cette version (aucun réseau réel). Un envoi sans preuve passe en « À vérifier » et n'est jamais rejoué.

## Périmètre

Sont dans le périmètre :

- l'authentification et ses contournements (session administrateur, clés d'API et d'agents, TOTP) ;
- le coffre et la manipulation des secrets (fuite par une API, un journal, un message d'erreur ou une réponse MCP) ;
- le serveur MCP et les outils exposés à un agent, en particulier la frontière lecture / écriture et la portée par projet ;
- le navigateur intégré : accès à une adresse interne ou aux métadonnées d'un nuage, évasion du proxy filtrant ;
- l'injection SQL dans le connecteur Postgres en lecture seule et l'évasion de ce mode ;
- l'exposition d'une instance mal configurée par défaut (ce qui écoute, sur quelle interface) ;
- les dépendances livrées dans l'image.

Ne sont **pas** dans le périmètre, par conception :

- une instance volontairement exposée sans TLS ni reverse proxy : c'est un choix de déploiement documenté, pas une vulnérabilité du produit ;
- l'accès à la machine hôte par quelqu'un qui a déjà les droits administrateur ou le volume `/data` ;
- le fait que le mot de passe généré soit stocké en clair, en droits 600, dans `/data` : c'est le compromis assumé de l'installation sans fichier à éditer ;
- les rapports automatisés sans reproduction ni impact décrit.

## Versions prises en charge

La dernière version publiée (aujourd'hui `0.2.x` ; `0.4.0` est préparée mais non publiée) reçoit les correctifs de sécurité. Les versions antérieures ne sont pas maintenues.

## Bonnes pratiques pour les utilisateurs

- Garder le port lié à `127.0.0.1` et exposer l'instance derrière un reverse proxy TLS ou un tunnel.
- Activer la double authentification (`npm run 2fa`) dès que l'instance est joignable autrement que depuis la machine locale.
- Créer une clé par agent, en lecture seule sauf besoin réel, et la révoquer quand l'agent ne sert plus.
- Sauvegarder tout le volume `/data` — la base, `secret` et `admin-password` — et ne jamais le joindre à un ticket.
- Vérifier `GET /healthz` depuis la supervision, et lire les journaux après chaque mise à jour.

## Remerciements

Les signalements utiles sont mentionnés dans les notes de version, sauf si vous demandez l'anonymat.

## Double authentification (TOTP), facultative

Searchtide n'impose jamais la 2FA : elle est désactivée par défaut, s'active volontairement dans Réglages (ou `npm run 2fa`) et la connexion par mot de passe reste normale tant qu'elle n'est pas activée. Une fois activée, le second facteur est exigé et une erreur de déchiffrement refuse la connexion (503), sans retour silencieux au mot de passe seul. L'activation est recommandée si l'instance est exposée à Internet ; l'avertissement de démarrage est informatif et se coupe avec `QUIET_2FA_WARNING=1`.


- Activation : **Réglages → Sécurité → Configurer**. Le secret est généré côté serveur, affiché une fois (QR + clé), puis activé seulement après un code valide.
- Le secret est chiffré par le coffre (clé dérivée de `SECRET`). `TOTP_SECRET` dans l'environnement reste prioritaire pour les instances existantes.
- Huit codes de secours à usage unique sont affichés une fois et stockés hachés. Conservez-les hors de l'ordinateur.
- Un cookie de session volé ne peut pas remplacer le secret : `POST /api/2fa/setup` répond 409 tant que la 2FA est active. Pour changer de secret, désactivez-la avec le mot de passe **et** un code, puis reconfigurez.
- Les routes `/api/2fa/*` sont réservées à la session administrateur (403 pour une clé d'API ou d'agent, y compris en lecture seule), limitées à 5 échecs par IP et par 15 minutes (limiteur distinct de celui de la connexion : des essais 2FA ne bloquent pas le login légitime), et répondent `Cache-Control: no-store`.
- **Anti-rejeu :** un code TOTP n'est accepté qu'une seule fois. Le pas de 30 s accepté est enregistré (`twofa.last_step`) dans une transaction ; deux connexions concurrentes avec le même code ne peuvent pas réussir ensemble. Le code saisi pour activer la 2FA est lui aussi consommé. Cela vaut pour `TOTP_SECRET` (CLI) comme pour le secret enregistré dans l'interface.

### Récupération si l'application d'authentification et les codes de secours sont perdus

1. Arrêtez l'instance.
2. Dans le volume de données, ouvrez la base avec `sqlite3 /data/searchtide.db` (ou le chemin de `DATABASE_PATH`).
3. Supprimez la ligne : `DELETE FROM twofa;` (le secret et les codes de secours sont effacés).
4. Redémarrez : la connexion par mot de passe seul est rétablie. Reconfigurez ensuite la 2FA dans Réglages.

## Sessions et rotation de SECRET

- Le cookie de session vaut `admin.<epoch>.<empreinte>` : `epoch` est en base et l'empreinte dépend de `ADMIN_PASSWORD`. La déconnexion, l'activation ou la désactivation de la 2FA incrémentent `epoch` et révoquent tous les appareils (la session en cours est réémise) ; changer le mot de passe invalide par l'empreinte.
- Une 2FA configurée mais illisible (SECRET changé) **échoue fermée** : la connexion répond 503, jamais mot de passe seul.
- Les codes de secours sont hachés avec un sel aléatoire propre à la ligne, indépendant de `SECRET`.
- Rotation : démarrez une fois avec `SECRET_OLD=<ancienne valeur>` et `SECRET=<nouvelle valeur>` pour rechiffrer `twofa.secret` et `twofa.pending`, puis retirez `SECRET_OLD` et redémarrez. Les codes de secours restent valides.

## Écritures, portée des clés et valeurs

- Toute écriture REST exige la même origine (`Sec-Fetch-Site` / `Origin` cohérents avec `Host` ou `PUBLIC_URL`) et un corps `application/json` (415 sinon). `/api/collect` et les clients Bearer sont exclus.
- En REST, les clés n'écrivent que sur une liste blanche (suivi, annotations, tableaux, module de projet, collecte, sync, valeur d'indicateur). Suppressions, modifications de projet et changements de source sont refusés (403) ; les agents enregistrent les valeurs via l'outil MCP `indicator_record`, pas par REST.
- Les clés d'API, de lecture seule et d'agent ne lisent en REST que les routes de la liste blanche (me, overview, sites, projects, indicators, portfolio, today, milestones, annotations, dashboards, jobs). Les routes d'exploitation, connexions, contacts, CRM, publications, modules, diagnostic, 2FA et purge sont réservées à la session administrateur (403 pour les clés et pour la démonstration anonyme). Les erreurs de tâches sont épurées avant exposition.
- Les valeurs d'indicateur sont validées côté serveur : jour réel entre 2000-01-01 et demain (un jour fourni invalide est refusé, jamais remplacé par aujourd'hui), valeur finie et |v| ≤ 10¹². Un import de lot accepte 366 valeurs au plus, en une transaction.
