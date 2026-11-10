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

## Périmètre

Sont dans le périmètre :

- l'authentification et ses contournements (session administrateur, clés d'API et d'agents, TOTP) ;
- le coffre et la manipulation des secrets (fuite par une API, un journal, un message d'erreur ou une réponse MCP) ;
- le serveur MCP et les outils exposés à un agent, en particulier la frontière lecture / écriture ;
- l'injection SQL dans le connecteur Postgres en lecture seule et l'évasion de ce mode ;
- l'exposition d'une instance mal configurée par défaut (ce qui écoute, sur quelle interface) ;
- les dépendances livrées dans l'image.

Ne sont **pas** dans le périmètre, par conception :

- une instance volontairement exposée sans TLS ni reverse proxy : c'est un choix de déploiement documenté, pas une vulnérabilité du produit ;
- l'accès à la machine hôte par quelqu'un qui a déjà les droits administrateur ou le volume `/data` ;
- le fait que le mot de passe généré soit stocké en clair, en droits 600, dans `/data` : c'est le compromis assumé de l'installation sans fichier à éditer ;
- les rapports automatisés sans reproduction ni impact décrit.

## Versions prises en charge

La dernière version publiée (aujourd'hui `0.2.x`) reçoit les correctifs de sécurité. Les versions antérieures ne sont pas maintenues.

## Bonnes pratiques pour les utilisateurs

- Garder le port lié à `127.0.0.1` et exposer l'instance derrière un reverse proxy TLS ou un tunnel.
- Activer la double authentification (`npm run 2fa`) dès que l'instance est joignable autrement que depuis la machine locale.
- Créer une clé par agent, en lecture seule sauf besoin réel, et la révoquer quand l'agent ne sert plus.
- Sauvegarder tout le volume `/data` — la base, `secret` et `admin-password` — et ne jamais le joindre à un ticket.
- Vérifier `GET /healthz` depuis la supervision, et lire les journaux après chaque mise à jour.

## Remerciements

Les signalements utiles sont mentionnés dans les notes de version, sauf si vous demandez l'anonymat.
