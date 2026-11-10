# Connecter Google (Search Console, et Play en option)

**Temps estimé :** ~15 min · **Comptes multiples :** oui · **Lecture seule.**

Searchtide lit Search Console avec un **compte de service** Google Cloud (fichier JSON). Si vous renseignez le bucket de la Play Console, la même connexion lit aussi les chiffres Google Play.

## Ce que ça débloque

- **Search Console** : clics, impressions, CTR, position, opportunités, état de l'import — pour les propriétés que vous autorisez.
- **Play** (si le bucket est renseigné) : installations par jour, installations actives, note moyenne, par nom de package.

## Avant de commencer

- Un compte Google avec accès à [Google Cloud Console](https://console.cloud.google.com/).
- Un accès **propriétaire** (ou « Restreint » suffisant pour la lecture) sur chaque propriété Search Console à lire.
- Pour Play : un accès à la Play Console et le droit de télécharger les rapports.

## Étapes

1. **Créer un projet Google Cloud** : <https://console.cloud.google.com/projectcreate>.
2. **Activer l'API Search Console** dans ce projet : <https://console.cloud.google.com/apis/library/searchconsole.googleapis.com>.
3. **Créer un compte de service**, puis une **clé JSON** : <https://console.cloud.google.com/iam-admin/serviceaccounts> → le compte → « Clés » → « Ajouter une clé » → « Créer une clé » → JSON. Le fichier se télécharge une seule fois.
4. Dans Searchtide : **Connexions → Google → Connecter**, déposez le fichier JSON (glisser-déposer, choix de fichier ou collage), puis **« Tester et enregistrer »**.
5. Searchtide affiche l'adresse du compte de service (`…@….iam.gserviceaccount.com`). Ajoutez-la comme utilisateur **« Restreint »** de chaque propriété dans [Search Console → Utilisateurs et autorisations](https://search.google.com/search-console/users). Sans cette étape, le test peut réussir mais **aucune propriété n'est visible**.
6. **Play, facultatif** : dans la Play Console, « Utilisateurs et autorisations », invitez la même adresse avec la vue des informations de l'app en **« Global »**. Puis « Télécharger les rapports » → copiez l'URI `gs://pubsite_prod_rev_…`, et collez-la dans le champ « Bucket Google Play ».
7. Rattachez Search Console à un projet : **projet → Sources → Rattacher**. Une ligne par site du projet ; choisissez la propriété correspondante. Cette association ne crée pas d'indicateur : clics et impressions viennent déjà de la source « site ».

## Ce que vous voyez après le test

- **Réussite :** « Connecté : {adresse du compte de service} », puis « {n} propriétés Search Console » (et « bucket Play accessible » si fourni).
- **Réussite avec avertissement :** « Aucune propriété visible : ajoutez {adresse} dans Search Console. » La connexion **est enregistrée** ; ajoutez l'adresse, puis cliquez « Tester » à nouveau.
- **Bucket Play refusé :** « Play : accès refusé au bucket. Vérifiez l'invitation dans la Play Console (la prise en compte peut prendre du temps). » Search Console continue de fonctionner.

## Erreurs fréquentes

| Message affiché | Cause | Action |
|---|---|---|
| « Ce fichier est un identifiant OAuth, pas un compte de service : créez une clé de compte de service. » | Le JSON contient `installed` ou `web` (identifiant OAuth). | Recommencez à l'étape 3 : c'est une **clé de compte de service** qu'il faut. |
| « Ce fichier n'est pas une clé de compte de service Google : il manque client_email ou private_key. » | JSON incomplet ou autre type de fichier. | Téléchargez à nouveau la clé JSON du compte de service. |
| « Ce fichier n'est pas un JSON valide. » | Copie partielle, ou fichier renommé. | Ouvrez le fichier et collez son contenu entier, accolades comprises. |
| « Permission manquante : activez l'API Search Console dans votre projet Google Cloud (étape 2 du guide). » | L'API n'est pas activée pour ce projet. | Activez-la à l'étape 2, attendez une minute, retestez. |
| « Google refuse cette clé : vérifiez qu'elle est complète et active. » | Clé supprimée, compte de service désactivé, horloge serveur très décalée. | Recréez une clé JSON ; vérifiez l'heure de la machine. |
| « Aucune propriété visible : ajoutez {adresse} dans Search Console. » | Le compte de service n'est pas autorisé sur les propriétés. | Ajoutez l'adresse en « Restreint » sur chaque propriété, puis « Tester ». |
| « Le bucket Google Play ressemble à `gs://pubsite_prod_rev_…`. » | URI incomplète ou nom nu. | Copiez l'URI exacte depuis « Télécharger les rapports ». |
| « Aucun rapport Google Play pour ce mois (vérifiez le nom du paquet et l'accès du compte de service). » | Package faux, ou rapport pas encore publié. | Vérifiez le package ; les rapports arrivent avec du retard en début de mois. |
| « Nom de package invalide (exemple : com.exemple.app). » | Valeur saisie dans l'indicateur Play. | Utilisez l'identifiant exact de l'application. |
| « Google ne répond pas. Réessayez dans un instant. » | Délai de 10 s dépassé. | Réessayez ; vérifiez l'accès réseau de l'instance. |

## Limites et sécurité

- **Lecture seule** : Search Console en lecture (`webmasters.readonly`) et Cloud Storage en lecture (`devstorage.read_only`). Aucune écriture chez Google.
- La clé privée est chiffrée et **jamais réaffichée** ; l'interface ne montre que l'adresse `client_email`.
- Search Console ne crée pas d'indicateur : les chiffres du projet sont la somme de ses sites. Un site sans propriété affiche « Non rattaché ».
- Un projet sans site affiche « Ajoutez d'abord un site au projet pour rattacher Search Console. »
- **Gmail en lecture n'est pas inclus** (prévu plus tard) : ce connecteur ne lit pas les messages.
- Play : seules trois mesures sont proposées (installs par jour, installs actifs, note). Les mesures issues de CSV ou d'API non vérifiées ne sont pas annoncées.
- Pour retirer : « Retirer » dans la carte, puis supprimez le compte de service ou la clé dans Google Cloud.

## Liens de ce guide (vérifiés le 10/11/2026)

| Lien | Code observé | Remarque |
|---|---|---|
| <https://console.cloud.google.com/projectcreate> | 302 → `accounts.google.com` | Normal hors session : connexion Google demandée. |
| <https://console.cloud.google.com/apis/library/searchconsole.googleapis.com> | 200 | Page publique de la bibliothèque d'API. |
| <https://console.cloud.google.com/iam-admin/serviceaccounts> | 302 → `accounts.google.com` | Connexion Google demandée. |
| <https://search.google.com/search-console/users> | 302 → `accounts.google.com` | Connexion Google demandée. |
| <https://console.cloud.google.com/apis/credentials> | 302 → `accounts.google.com` | Utilisé par le guide PageSpeed. |

GO est un monogramme, pas le logo Google : aucun logo de marque n'est utilisé.
