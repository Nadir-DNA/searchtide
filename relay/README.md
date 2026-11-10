# Searchtide Connect — relais OAuth Stripe

Worker Cloudflare + D1. Il permet à une instance Searchtide de lire un compte Stripe sans stocker la clé de plateforme. **Aucune donnée Stripe n'est conservée** : seuls un identifiant `stripe_user_id`, des empreintes de jetons et des compteurs sont en base.

Ce service est optionnel : la clé restreinte `rk_` reste la voie recommandée et n'envoie rien à ce relais.

## Déploiement

Prérequis : un compte Cloudflare avec la zone du domaine, `wrangler` authentifié, une plateforme Stripe Connect.

```bash
cd relay
wrangler d1 create searchtide-connect          # recopier database_id dans wrangler.toml
wrangler d1 execute searchtide-connect --remote --file=schema.sql
wrangler secret put STRIPE_READ_KEY            # clé restreinte rk_live (lectures)
wrangler secret put STRIPE_OAUTH_KEY           # sk_live, uniquement /oauth/token et /oauth/deauthorize
wrangler secret put WEBHOOK_SECRET             # secret du webhook Connect
wrangler secret put STATE_SECRET               # 32 octets aléatoires
wrangler secret put RATE_SECRET                # 32 octets aléatoires, sel de l'empreinte IP (CA58)
wrangler deploy
```

Six valeurs sont nécessaires : les cinq secrets ci-dessus (`STRIPE_READ_KEY`, `STRIPE_OAUTH_KEY`, `WEBHOOK_SECRET`, `STATE_SECRET`, `RATE_SECRET`) et le client Stripe public `STRIPE_CLIENT_ID`, déjà dans `wrangler.toml` (compte plateforme réel depuis la v0.2.3). Aucun secret ne va dans le fichier ; `RATE_SECRET` sert uniquement à calculer l'empreinte HMAC de l'IP pour la limitation de débit. L'URI de retour enregistrée dans Stripe doit être exactement `https://connect.nadirdaoudi.com/oauth/callback`.

Webhook Connect : `https://connect.nadirdaoudi.com/v1/webhook`, événement `account.application.deauthorized` uniquement.

Limitation de débit : le Worker plafonne `/v1/start` à 20 requêtes/heure/IP et `/authorize`, `/oauth/authorize`, `/oauth/callback` à 60/heure/IP. Sur le plan gratuit, Cloudflare n'autorise **qu'une seule** règle de limitation (période 10 s, blocage 10 s, champs Path et IP) : la poser sur `/v1/start`, **10 requêtes / 10 s par IP**, action « Block » 10 s. Les routes `/oauth/*` restent couvertes par la limite D1 du Worker.

## Mode test et production

Le Worker tourne en `MODE = "live"` depuis le 10 novembre 2026 : il accepte les comptes réels. Le mode reste réglable par `MODE = "test"` pour un environnement de recette, sans changer le code des instances. `GET /privacy` refuse de servir la politique en mode `live` tant qu'il reste un `[À compléter]` (il n'en reste plus depuis cette date).

## Rotation du secret du webhook

Stripe peut envoyer **plusieurs signatures `v1`** dans un même en-tête pendant une rotation : le Worker les accepte toutes et compare à temps constant. Procédure :

1. créer un nouvel endpoint Connect (même URL, même événement) avec la clé `sk_live` ;
2. `WEBHOOK_SECRET` ← nouveau secret, `WEBHOOK_SECRET_PREVIOUS` ← ancien secret ;
3. `wrangler deploy`, vérifier une livraison `200` ;
4. supprimer l'ancien endpoint dans Stripe, puis retirer `WEBHOOK_SECRET_PREVIOUS`.

Le Worker supprime toujours le jeton local à la révocation ; si Stripe refuse la désautorisation, `/v1/revoke` répond **502** avec « Retirez l'application dans votre Dashboard Stripe » et l'instance affiche cet avertissement.

## Vérifier localement

```bash
node --test relay/worker.test.ts
```

Les tests utilisent un stockage mémoire et un Stripe simulé : aucun appel réseau réel.
