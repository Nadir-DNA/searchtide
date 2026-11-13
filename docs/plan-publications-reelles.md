# Plan : publication réelle (module Publications, inspiré de Postiz)

Étude du 13 novembre 2026 sur gitroomhq/postiz-app (AGPL-3.0, copyright Nevo David), lecture seule, clone en répertoire temporaire.

## Licence

Tout code repris ou adapté de Postiz est sous AGPL-3.0. Il reste isolé dans `server/publishers/providers/` :
- un `LICENSE` AGPL-3.0 dans ce dossier ;
- en-tête de chaque fichier : source d'origine, copyright Nevo David conservé, modifications signalées ;
- le reste de Searchtide (MIT) n'importe ces fichiers que via l'interface `Provider` ci-dessous ;
- la décision de relicencier le module revient à Nadir (hors de ce plan).

## Ce que Postiz fait (carte)

| Sujet | Postiz | Searchtide aujourd'hui |
| --- | --- | --- |
| Pile | NestJS, Prisma/Postgres, Redis, Temporal (workflows `post.workflow.v1.x`) | Hono, SQLite, `registerJob` d'une minute |
| Contrat fournisseur | `SocialProvider` : `generateAuthUrl`, `authenticate`, `refreshToken`, `post`, `comment`, `checkValidity`, `maxLength`, `checkPostStatus`, `finalizePost`, `analytics` | `publishToNetwork()` factice, `NETWORK_LIMITS` en dur |
| Fournisseurs | ~38 (X, LinkedIn perso/page, Facebook, Instagram, Threads, TikTok, YouTube, Bluesky, Mastodon, Reddit, Pinterest, Discord, Slack, Telegram, WordPress, Medium…) | 6 réseaux déclarés, aucun réel |
| Erreurs typées | `RefreshToken`, `Disconnect`, `BadBody`, `PublishedWithError` | `PublishResult.kind` (auth, format, quota, rate, network, refused, to_verify) |
| Publication asynchrone | `postPending` + `checkPostStatus` + `finalizePost` (vidéo TikTok/YouTube) | absent |
| Jetons | cron et workflow de rafraîchissement par fournisseur | `server/connections.ts` (OAuth Stripe) |

## Ce qui est déjà meilleur dans Searchtide (à garder)

Clé d'idempotence et état « À vérifier » (jamais de rejeu aveugle), approbation liée au contenu exact, reprise après plantage, plafond quotidien par compte, portée par projet, MCP. Ne pas les remplacer par le modèle Postiz.

## Architecture cible

```
server/publishers/
  queue.ts               inchangé : état, tentatives, idempotence, approbations
  provider.ts            (MIT) interface Provider + PublishResult
  providers/             (AGPL) un fichier par réseau
    LICENSE
    x.ts  linkedin.ts  ...
  tokens.ts              (MIT) stockage chiffré + rafraîchissement, réutilise connections.ts
```

Interface minimale (reprend le vocabulaire, pas le code) :
`id`, `limits(settings)`, `authUrl()`, `exchange(code)`, `refresh(token)`, `validate(post, media)`, `publish(post, token) → {url} | pending`, `poll(pending)`.

`publishToNetwork` choisit le fournisseur du compte ; le fournisseur factice reste pour les tests.

## Ordre de travail

1. **Socle** : `provider.ts`, `tokens.ts` (secret chiffré au repos, jamais renvoyé à l'interface), état `connecté / à renouveler / erreur` dans l'écran Connexions, comme pour Stripe.
2. **LinkedIn** (texte, puis image) : OAuth, publication, rafraîchissement.
3. **X** : OAuth 2 PKCE, texte, média par morceaux.
4. **Publication asynchrone** (`pending` + `poll`) avant TikTok et YouTube.
5. Ensuite par valeur : Facebook/Instagram/Threads (Meta), Bluesky, Mastodon.
6. Chaque fournisseur : tests avec serveur de réseau simulé, jamais d'appel réel en CI.

## Points ouverts (à décider)

- URL publique HTTPS pour les retours OAuth : même contrainte que Stripe, relais existant (`relay/`) à réutiliser ?
- Application développeur à créer chez chaque réseau (LinkedIn, X, Meta, TikTok) ; revue et quotas propres à chacun, hors code.
- Les en-têtes de licence des sous-dossiers de Postiz (`apps/`, `libraries/`) et ses accords de contribution (CCLA/ICLA) n'ont pas été relus.
- Postiz Cloud applique des quotas et conditions propres aux réseaux ; les conditions des API de chaque réseau valent aussi pour Searchtide.
