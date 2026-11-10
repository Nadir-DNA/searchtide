# Notes de version — Searchtide v0.2.3

Publiée le 10/11/2026. Version de service : le relais **Searchtide Connect** passe en **mode réel**. Elle ne change ni la base ni les données des instances ; le volume `/data` est conservé.

## Relais en mode réel

- Compte plateforme Stripe « Searchtide » vérifié (entreprise et identité), contrat Connect accepté.
- Webhook Connect réel, un seul endpoint, événement `account.application.deauthorized` vers `https://connect.nadirdaoudi.com/v1/webhook`.
- Clés réelles : `rk_live` pour les lectures, `sk_live` réservée à `/oauth/token` et `/oauth/deauthorize`. `STATE_SECRET` et `RATE_SECRET` conservés.
- L'instance n'a rien à changer : elle affiche le mode renvoyé par le relais (« (test) » disparaît en réel).

## Webhook et révocation

- **Rotation du secret** : l'en-tête `Stripe-Signature` peut contenir plusieurs `v1` ; le Worker les accepte tous et `WEBHOOK_SECRET_PREVIOUS` couvre la transition. Procédure dans `relay/README.md`.
- **Comparaison à temps constant** des signatures.
- **Révocation honnête (CA61)** : quand Stripe refuse la désautorisation, `/v1/revoke` répond **502** avec « Retirez l'application dans votre Dashboard Stripe » ; le jeton local est quand même supprimé et l'instance affiche l'avertissement. Une application déjà retirée côté Stripe est traitée comme un succès idempotent. Les trois échecs (502, relais injoignable, délai) sont testés côté instance.
- **Mode cohérent (CA59)** : les clés doivent correspondre à `MODE` (`rk_live_`/`sk_live_` en réel, `rk_test_`/`sk_test_` en test) ; sinon santé, démarrage et OAuth répondent 503 « Mode incohérent ».
- **Déploiement sûr (CA60)** : `npm run deploy:relay` refuse un changement de mode non demandé, déploie et vérifie le mode après coup ; `wrangler deploy` direct est proscrit.
- **Contrat des lectures (CA62)** : un test vérifie que chaque paramètre émis par l'instance passe la liste blanche du relais.

## Bêta

La **Connexion avec Stripe** reste en **bêta** : elle est ouverte aux comptes réels, mais la clé restreinte `rk_` reste la voie recommandée pour un compte de production (lecture seule garantie par Stripe, aucune donnée ne quitte l'instance). Le mode affiché sur la connexion indique s'il s'agit d'un compte test ou réel.

## Installation et mise à jour

```bash
docker run -d --name searchtide -p 127.0.0.1:3030:3030 -v searchtide:/data ghcr.io/nadir-dna/searchtide:0.2.3
```

Depuis 0.2.2 : remplacer l'image et redémarrer. Aucune migration n'est nécessaire.

## Vérifications

- Compte réel de test (Fund-Road) : autorisation, lectures (solde, transactions, abonnements, clients, compte) en **200**, révocation depuis l'instance, webhook réel livré en **200**, ligne `tokens` supprimée, accès au compte ensuite **403**.
- `/v1/health` en `live`, `/privacy` en 200 avec la date, lecture sans jeton **401**, webhook sans signature **400**, `/v1/start` avec le `client_id` réel.
- Suite unitaire **237 réussis / 8 ignorés / 0 échec** (245), vérification des types, construction de l'interface, 23 tests de bout en bout, scan de secrets **0 alerte**.

## Réserves connues

- Le relais dépend d'un seul compte plateforme et d'un seul domaine ; pas de bascule multi-région.
- Les tests Postgres et Supabase réels restent ignorés dans la CI ; Firefox et WebKit ne sont pas couverts.
