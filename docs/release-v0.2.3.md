# Notes de version — Searchtide v0.2.3 (à paraître)

Version de service : le relais **Searchtide Connect** passe en **mode réel**. Elle ne change ni la base ni les données des instances ; le volume `/data` est conservé.

## Relais en mode réel

- Compte plateforme Stripe « Searchtide » vérifié (entreprise et identité), contrat Connect accepté.
- Webhook Connect réel, un seul endpoint, événement `account.application.deauthorized` vers `https://connect.nadirdaoudi.com/v1/webhook`.
- Clés réelles : `rk_live` pour les lectures, `sk_live` réservée à `/oauth/token` et `/oauth/deauthorize`. `STATE_SECRET` et `RATE_SECRET` conservés.
- L'instance n'a rien à changer : elle affiche le mode renvoyé par le relais (« (test) » disparaît en réel).

## Webhook : dette remboursée

- **Rotation du secret** : l'en-tête `Stripe-Signature` peut contenir plusieurs `v1` ; le Worker les accepte tous et `WEBHOOK_SECRET_PREVIOUS` couvre la transition. Procédure dans `relay/README.md`.
- **Comparaison à temps constant** des signatures.
- **Révocation honnête** : quand Stripe refuse la désautorisation, `/v1/revoke` répond **502** avec « Retirez l'application dans votre Dashboard Stripe » ; le jeton local est quand même supprimé et l'instance affiche l'avertissement.

## Bêta

La **Connexion avec Stripe** reste en **bêta** : elle est désormais ouverte aux comptes réels, mais la clé restreinte `rk_` reste la voie recommandée pour un compte de production (lecture seule garantie par Stripe, aucune donnée ne quitte l'instance). Le mode affiché sur la connexion indique s'il s'agit d'un compte test ou réel.

## Installation et mise à jour

```bash
docker run -d --name searchtide -p 3030:3030 -v searchtide:/data ghcr.io/nadir-dna/searchtide:0.2.3
```

Depuis 0.2.2 : remplacer l'image et redémarrer. Aucune migration n'est nécessaire.

## Vérifications prévues avant publication

- `/v1/health` → `mode: "live"` ; `/v1/start` avec le `client_id` réel ; signature invalide → 400 ; lecture sans jeton → 401.
- Suite unitaire (relais inclus), types, construction, e2e et scan de secrets.
- Premier parcours OAuth réel effectué par le propriétaire, puis révocation des deux côtés.

## Réserves connues

- Le relais dépend d'un seul compte plateforme et d'un seul domaine ; pas de bascule multi-région.
- Les tests Postgres et Supabase réels restent ignorés dans la CI ; Firefox et WebKit ne sont pas couverts.
