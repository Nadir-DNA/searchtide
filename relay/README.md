# Searchtide Connect — relais OAuth Stripe

Worker Cloudflare + D1. Il permet à une instance Searchtide de lire un compte Stripe sans stocker la clé de plateforme. **Aucune donnée Stripe n'est conservée** : seuls un identifiant `stripe_user_id`, des empreintes de jetons et des compteurs sont en base.

Ce service est optionnel : la clé restreinte `rk_` reste la voie recommandée et n'envoie rien à ce relais.

## Déploiement

Prérequis : un compte Cloudflare avec la zone du domaine, `wrangler` authentifié, une plateforme Stripe Connect.

```bash
cd relay
wrangler d1 create searchtide-connect          # recopier database_id dans wrangler.toml
wrangler d1 execute searchtide-connect --remote --file=schema.sql
wrangler secret put STRIPE_KEY                 # clé de plateforme (test d'abord)
wrangler secret put WEBHOOK_SECRET             # secret du webhook Connect
wrangler secret put STATE_SECRET               # 32 octets aléatoires
wrangler deploy
```

Le client Stripe (`STRIPE_CLIENT_ID`) est public et déjà dans `wrangler.toml` (environnement de test). L'URI de retour enregistrée dans Stripe doit être exactement `https://connect.nadirdaoudi.com/oauth/callback`.

Webhook Connect : `https://connect.nadirdaoudi.com/v1/webhook`, événement `account.application.deauthorized` uniquement.

## Mode test et production

`MODE = "test"` n'accepte que des comptes Stripe en mode test ; l'instance affiche « (test) ». Le passage en production se fait avec des secrets et un `client_id` de production, sans changer le code des instances. `GET /privacy` refuse de servir la politique en mode `live` tant qu'il reste un `[À compléter]`.

## Vérifier localement

```bash
node --test relay/worker.test.ts
```

Les tests utilisent un stockage mémoire et un Stripe simulé : aucun appel réseau réel.
