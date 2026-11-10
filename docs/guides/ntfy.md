# Connecter ntfy

**Temps estimé :** ~1 min · **Un seul compte** · **Envoi de notifications uniquement.**

Searchtide publie ses alertes sur un **sujet** ntfy, que l'application de votre téléphone écoute. Le sujet fait office de mot de passe : il est généré aléatoirement et n'est affiché qu'une fois.

## Ce que ça débloque

- Alertes sur le téléphone : site hors ligne, relevé en erreur, forte baisse, nouvelle vente.

## Avant de commencer

- L'application **ntfy** installée sur le téléphone (Android, iOS) ou un client web.
- Un sujet au hasard : sur le serveur public `ntfy.sh`, quiconque connaît le sujet peut lire les messages. Un sujet de 32 caractères aléatoires évite cela.

## Étapes

1. Dans Searchtide : **Connexions → ntfy → Connecter**. Le champ **Sujet** est **généré automatiquement** ; gardez-le, ou remplacez-le par une longue chaîne aléatoire.
2. Laissez le serveur `https://ntfy.sh`, ou indiquez l'adresse de votre serveur auto-hébergé (HTTPS).
3. **« Tester et enregistrer »** : une notification « Les notifications fonctionnent. » est publiée.
4. Après l'enregistrement, le sujet s'affiche **une seule fois** avec un bouton **Copier**. Copiez-le.
5. Dans l'application ntfy : **S'abonner au sujet** et collez-le. La notification de test doit apparaître.
6. Si le serveur est protégé, renseignez un **jeton d'accès** facultatif avant le test.

## Ce que vous voyez après le test

- **Réussite :** « Connecté : {hôte} », puis « Notification envoyée : vérifiez votre téléphone. »
- Si le téléphone n'affiche rien, c'est presque toujours que l'application n'est pas abonnée au bon sujet, ou que les notifications système sont coupées.

## Erreurs fréquentes

| Message affiché | Cause | Action |
|---|---|---|
| « Le sujet n'accepte que lettres, chiffres, tiret et tiret bas (64 caractères au plus). » | Espace, accent ou caractère spécial dans le sujet. | Utilisez le sujet généré, ou des lettres/chiffres/`-`/`_` seulement. |
| « L'adresse du serveur doit commencer par `https://`. » | Serveur saisi sans schéma ou en `http://`. | Utilisez `https://ntfy.sh` ou l'URL HTTPS de votre serveur. |
| « ntfy refuse l'accès : vérifiez le jeton, ou le droit d'écrire sur ce sujet. » | Jeton invalide, ou sujet protégé en écriture. | Recréez un jeton, ou choisissez un sujet autorisé. |
| « ntfy ne répond pas. Réessayez dans un instant. » | Délai de 10 s dépassé. | Réessayez ; vérifiez l'accès réseau de l'instance. |

## Limites et sécurité

- **Un seul sujet** par instance. Pour le changer : « Remplacer la clé » avec un nouveau sujet, puis **se réabonner** sur le téléphone.
- Le sujet n'est **pas réaffiché** après l'enregistrement ; l'indice affiché masque le sujet (`hôte · sujet masqué`). Si vous l'avez perdu, remplacez-le.
- Sur `ntfy.sh`, le sujet est le seul secret : ne le partagez pas et ne le mettez pas dans un dépôt.
- Le connecteur **publie** des notifications (fonction assumée), au seul sujet configuré. Aucune autre requête.
- Auto-hébergement possible : n'importe quel serveur ntfy compatible HTTPS convient.
- Pour retirer : « Retirer » dans la carte ; le sujet reste utilisable par d'autres, changez-le si besoin.

## Liens de ce guide (vérifiés le 10/11/2026)

| Lien | Code observé | Remarque |
|---|---|---|
| <https://ntfy.sh> | 200 | Site et application ntfy. |
| <https://docs.ntfy.sh/> | 200 | Documentation ntfy (sujets, jetons, auto-hébergement). |
