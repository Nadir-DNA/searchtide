# Connecter Stripe

**Temps estimé :** ~3 min · **Comptes multiples :** oui · **Lecture seule.**

Searchtide lit votre compte Stripe avec une **clé restreinte** (`rk_`). Aucun mouvement d'argent n'est possible : le connecteur n'envoie que des requêtes `GET`.

## Ce que ça débloque

- CA net (mouvements du solde : ventes, remboursements, frais déduits)
- MRR (somme mensuelle nette des abonnements actifs)
- Abonnements actifs
- Nouveaux clients (créés dans la journée)

## Avant de commencer

- Un compte Stripe dont vous êtes administrateur (ou un rôle qui peut créer une clé restreinte).
- Savoir dans quel **mode** vous êtes : `rk_live_` pour la production, `rk_test_` pour les tests. Searchtide accepte les deux et affiche un badge « test » pour une clé de test.

## Étapes

1. Ouvrez la page des clés : <https://dashboard.stripe.com/apikeys> → **« Créer une clé limitée »**.
2. Dans la liste des autorisations, mettez **« Lecture »** sur :
   - **Customers**
   - **Subscriptions**
   - **Balance**
   - **Balance Transaction Sources** (nécessaire pour lire les transactions du solde)
3. Laissez **« Aucune »** partout ailleurs. Une permission accordée en plus est inutile.
4. Copiez la clé `rk_…` : Stripe ne la montre **qu'une fois**.
5. Dans Searchtide : **Connexions → Stripe → Connecter**, collez la clé dans « Clé limitée », puis **« Tester et enregistrer »**.
6. Pour plusieurs comptes : rouvrez la carte et ajoutez une deuxième clé avec un libellé différent.

## Ce que vous voyez après le test

- **Réussite :** « Connecté : {nom du compte} », puis « {nom}, mode production|test, devise EUR ». La carte passe à « Connecté » et « Rattacher à un projet » apparaît.
- Ensuite, sur un projet : **Sources → Rattacher**, puis cochez les indicateurs prêts (CA net, MRR, Abonnements actifs, Nouveaux clients).

## Erreurs fréquentes

| Message affiché | Cause | Action |
|---|---|---|
| « Une clé limitée commence par `rk_`. » | La valeur ne commence pas par `rk_live_` ou `rk_test_`. | Recopiez la clé en entier, sans espace ni retour à la ligne. |
| « Clé complète refusée : créez une clé limitée en lecture. » | Vous avez collé une clé `sk_`. | Créez une clé restreinte (`rk_`) : une clé complète donne tous les droits, Searchtide la refuse. |
| « Stripe refuse cette clé : vérifiez qu'elle est complète et active. » | Clé supprimée, révoquée ou mal copiée. | Vérifiez la clé dans le Dashboard, recréez-la si besoin. |
| « Permission manquante : Customers en lecture. » (ou `Subscriptions`, `Balance`) | L'autorisation correspondante n'est pas en « Lecture ». | Modifiez la clé dans Stripe, ou créez-en une nouvelle avec les quatre autorisations. |
| « Stripe ne répond pas. Réessayez dans un instant. » | Délai de 10 s dépassé. | Réessayez ; si cela dure, vérifiez que l'instance a bien accès à Internet. |
| « Cette clé est déjà enregistrée sous « {libellé} ». » | La même clé est déjà dans le coffre. | Utilisez la connexion existante, ou créez une autre clé pour un autre compte. |

## Limites et sécurité

- **Aucune écriture** chez Stripe : pas de remboursement, pas de modification d'abonnement, pas de création de client.
- **OAuth** (« Connexion avec Stripe ») n'est pas disponible en v0.2.0 : la clé `rk_` est la seule voie. Une connexion en un clic est prévue pour une version ultérieure.
- La clé est chiffrée dans l'instance et n'est **jamais réaffichée**. Seuls le préfixe et les 4 derniers caractères servent d'indice.
- Pour retirer : **Retirer** dans la carte. Pensez aussi à supprimer la clé dans Stripe : <https://dashboard.stripe.com/apikeys>.
- Le mode test et le mode production sont deux connexions distinctes : ne mélangez pas les deux dans un même projet.

## Liens de ce guide (vérifiés le 10/11/2026)

| Lien | Code observé | Remarque |
|---|---|---|
| <https://dashboard.stripe.com/apikeys> | 303 → `/login` | Normal hors session : redirige vers la connexion Stripe. |

ST est un monogramme, pas le logo Stripe : aucun logo de marque n'est utilisé.
