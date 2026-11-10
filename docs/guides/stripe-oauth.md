# Stripe — Connexion avec Stripe (bêta)

La **clé limitée `rk_`** reste la voie recommandée : lecture seule garantie par Stripe, aucune donnée ne quitte votre instance. « Connexion avec Stripe » est une **bêta** qui passe par le service **Searchtide Connect**, opéré par Nadir DAOUDI.

> **Bêta.** Le relais accepte les comptes réels ; le mode est affiché sur la connexion. Pour un compte de production, la clé limitée `rk_` reste la voie recommandée.

## Ce que fait le service

1. Vous êtes redirigé vers Stripe pour autoriser Searchtide Connect sur votre compte.
2. Searchtide Connect garde un lien entre votre instance et votre compte, sous la forme d'un jeton que seule votre instance connaît.
3. Les lectures (solde, transactions, abonnements, nouveaux clients) passent par lui : **aucune donnée Stripe n'est conservée**.

Stripe n'offre pas de « lecture seule » pour ce type de connexion : son écran indique « lecture et écriture ». Le relais n'émet que des requêtes de lecture ; son code est public.

- Politique de confidentialité : `https://connect.nadirdaoudi.com/privacy`
- Code du relais : `https://github.com/Nadir-DNA/searchtide/tree/main/relay`

## Dans Searchtide

**Connexions → Connexion avec Stripe**, cochez le consentement, puis **Continuer vers Stripe** (le libellé porte « (test) » si le relais est en mode test). Revenu sur l'instance, la connexion affiche le compte et le mode. La révocation se fait par **Retirer** ou **Révoquer** : le jeton local est supprimé et le relais est appelé.

Si le service est indisponible, Searchtide affiche un message et propose **Utiliser une clé limitée** : rien ne quitte alors votre instance.

## Auto-héberger le relais

Le dossier `relay/` du dépôt contient le Worker Cloudflare et son schéma D1. Voir `relay/README.md` pour les secrets, le déploiement et le webhook. `RELAY_URL` dans l'instance pointe vers votre relais ; vide, le bouton est absent.
