# FAQ — messages d'erreur des connexions

**Périmètre :** écran **Connexions**, panneau de connexion, rattachement à un projet.
**Guides détaillés :** [stripe](stripe.md) · [google](google.md) · [postgres](postgres.md) · [smtp](smtp.md) · [ntfy](ntfy.md) · [pagespeed](pagespeed.md) · [api-json](api-json.md) · [analytics](analytics.md) · [saisie-manuelle](saisie-manuelle.md)

## Comment lire un message

- Le message s'affiche **sous le bouton « Tester et enregistrer »**, en rouge, et il est lu par les lecteurs d'écran (`role="alert"`).
- **Rien n'est enregistré** quand le test échoue. Le formulaire garde les champs, y compris le secret, en mémoire de page uniquement : vous pouvez corriger et retester.
- Un message dit toujours **la cause et l'action**. S'il ne suffit pas, ouvrez le guide du connecteur : la même étape y est détaillée.
- « Tester », sur une connexion existante, relance le test et met à jour le statut. Cela ne modifie ni la clé ni les indicateurs.

## Les cas prévus (table de référence)

| Cas | Message exact | Ce qu'il faut faire |
|---|---|---|
| 401, clé invalide | « {Fournisseur} refuse cette clé : vérifiez qu'elle est complète et active. » | Recopiez la clé entière, sans espace. Si elle a été supprimée ou révoquée chez le fournisseur, créez-en une nouvelle. |
| 403, permission manquante | « Permission manquante : {ressource} en lecture. » | Accordez la lecture sur la ressource nommée, puis retestez. Voir l'étape correspondante du guide. |
| Délai de 10 s | « {Fournisseur} ne répond pas. Réessayez dans un instant. » | Réessayez. Si cela dure, vérifiez que l'instance a accès à Internet et que le fournisseur n'est pas en panne. |
| Format Stripe | « Une clé limitée commence par `rk_`. » | Utilisez une clé restreinte `rk_live_` ou `rk_test_`. |
| Format Google | « Ce fichier est un identifiant OAuth, pas un compte de service : créez une clé de compte de service. » | Recommencez la création de la clé JSON du **compte de service**. |
| Google valide, 0 propriété | « Aucune propriété visible : ajoutez {client_email} dans Search Console. » | **La connexion est enregistrée.** Ajoutez l'adresse comme utilisateur « Restreint » des propriétés, puis « Tester » à nouveau. |
| Bucket Play inaccessible | « Play : accès refusé au bucket. Vérifiez l'invitation dans la Play Console (la prise en compte peut prendre du temps). » | **La connexion est enregistrée** (Search Console fonctionne). Vérifiez l'invitation Play, puis retestez plus tard. |
| SMTP refusé | « Identifiant ou mot de passe refusé. Avec Gmail, utilisez un mot de passe d'application, pas votre mot de passe. » | Activez la validation en 2 étapes, créez un mot de passe d'application de 16 caractères, collez-le sans espaces. |
| Postgres superutilisateur | « Compte superutilisateur refusé : créez un compte en lecture seule. » | Créez un rôle simple avec `GRANT SELECT` (bloc SQL du guide Postgres). |

## Autres messages que vous pouvez voir

| Message exact | Sens et action |
|---|---|
| « Ajoutez une valeur SECRET de 32 caractères ou plus dans .env, puis redémarrez. Elle chiffre vos clés. » | Le coffre est inutilisable : `SECRET` est absent, vaut `dev-secret`, ou fait moins de 32 caractères. Aucune connexion ne peut être enregistrée. Corrigez `.env`, redémarrez. En Docker, la valeur est générée au premier lancement et enregistrée dans le volume (`/data/secret`) : ne la changez pas. |
| « Cette clé est déjà enregistrée sous « {libellé} ». » | La même clé est déjà dans le coffre pour ce connecteur. Utilisez la connexion existante, ou créez une autre clé chez le fournisseur. |
| « Désactivé en démonstration. » | L'instance tourne en mode DEMO : les formulaires de connexion sont désactivés. Le catalogue reste consultable. |
| « Clé complète refusée : créez une clé limitée en lecture. » | Une clé `sk_` a été collée. Searchtide n'accepte que les clés restreintes `rk_`. |
| « Source retirée » (sur un indicateur) | La connexion utilisée par cet indicateur a été supprimée. L'historique est conservé. Rattachez l'indicateur à une autre connexion. |
| « Aucun compte {connecteur} connecté : ajoutez {connecteur} dans Connexions » | L'indicateur n'a pas de connexion associée (souvent après une migration d'ancien réglage `.env`). Rattachez une connexion. |
| « Ce compte peut écrire : utilisez un compte en lecture seule (modèle dans le guide). » | Avertissement Postgres, pas un refus. La connexion est enregistrée, mais le rôle accorde des droits d'écriture : remplacez-le par un rôle `SELECT`. |
| « Cette requête essaie d'écrire : seules les lectures sont acceptées. » | La requête SQL contient une écriture, ou le moteur l'a refusée dans la transaction `READ ONLY`. Réécrivez en `SELECT`. |
| « Le sujet n'accepte que lettres, chiffres, tiret et tiret bas (64 caractères au plus). » | Sujet ntfy invalide. Utilisez le sujet généré. |
| « Cette adresse n'est pas sur le domaine autorisé ({origine}) : le jeton ne lui est jamais envoyé. » | L'URL JSON n'est pas sur le domaine de la connexion API JSON. Utilisez la même origine. |
| « L'adresse redirige ailleurs : indiquez l'adresse finale. » | L'API JSON redirige (3xx) ; Searchtide refuse pour ne pas envoyer le jeton ailleurs. Donnez l'URL finale. |
| « Pas de nombre à « {chemin} ». » | Le chemin JSON ne pointe pas sur une valeur numérique. Corrigez le chemin. |
| « Quota PageSpeed dépassé : réessayez plus tard, ou ajoutez une clé API (connexion PageSpeed). » | Quota partagé épuisé (essai sans clé). Ajoutez une clé API ou attendez. |

## Questions fréquentes

**J'ai perdu le sujet ntfy, comment le retrouver ?**
Il n'est affiché qu'une fois, à l'enregistrement. S'il est perdu, utilisez « Remplacer la clé » avec un nouveau sujet, puis réabonnez le téléphone. L'indice affiché masque volontairement le sujet.

**J'ai changé `SECRET`, toutes mes connexions sont en erreur.**
C'est attendu : les clés chiffrées ne sont plus lisibles. Remettez l'ancien `SECRET` et redémarrez, ou ressaisissez chaque clé. Sauvegardez toujours `SECRET` avec la base.

**Pourquoi la connexion Google est-elle acceptée avec « aucune propriété » ?**
Le compte de service fonctionne, mais il n'est autorisé sur aucune propriété. Searchtide enregistre la connexion pour que vous puissiez ajouter l'adresse dans Search Console sans recommencer. Le message donne cette adresse.

**Le bucket Play est refusé, faut-il tout refaire ?**
Non. Search Console reste utilisable. Corrigez l'invitation dans la Play Console (vue des informations de l'app en « Global ») ; la prise en compte peut prendre du temps. Le bucket est facultatif.

**Pourquoi le test PageSpeed réussit-il alors qu'aucune mesure n'est encore revenue ?**
Une mesure Lighthouse complète dure souvent plus de 10 s. Le test s'arrête volontairement à 6 s : une absence d'erreur de clé à cet instant prouve que Google accepte la clé. Les mesures réelles se font ensuite au relevé quotidien.

**Puis-je utiliser plusieurs comptes Stripe ou Postgres ?**
Oui, avec un libellé par compte, et autant de connexions que nécessaire. SMTP, ntfy et PageSpeed n'acceptent qu'un compte.

**Que se passe-t-il si je retire une connexion ?**
La ligne et ses secrets sont supprimés. Les indicateurs liés ne sont pas supprimés : ils passent en erreur « Source retirée » et gardent leur historique. Pensez à supprimer la clé chez le fournisseur.

**Un agent ou une clé d'API peut-il lire mes clés ?**
Non. Une clé d'API ou un agent MCP peut lister les connexions (id, type, libellé, indice, statut), jamais les secrets ni les réglages. En DEMO sans session, ni indice ni réglage.

## Ce qu'il ne faut jamais envoyer au support

N'envoyez **jamais** : une clé Stripe, un fichier JSON de compte de service, un mot de passe ou mot de passe d'application, une URL Postgres complète, un sujet ntfy, une clé API PageSpeed, un jeton d'API JSON, un `.env`, une base ou une sauvegarde, une capture non masquée d'un de ces éléments.

Pour un diagnostic, suffisent : le connecteur concerné, le message exact affiché, l'étape où cela bloque, la version affichée ou le tag (`v0.2.0`), et le nom du fournisseur sans identifiant secret.

## Liens de ce document (vérifiés le 10/11/2026)

| Lien | Code observé |
|---|---|
| <https://github.com/Nadir-DNA/searchtide> | 200 |
| <https://github.com/Nadir-DNA/searchtide/releases/tag/v0.2.0> | 200 |
| <https://dashboard.stripe.com/apikeys> | 303 → `/login` |
| <https://console.cloud.google.com/apis/library/searchconsole.googleapis.com> | 200 |
| <https://support.google.com/accounts/answer/185833> | 200 |
| <https://ntfy.sh> | 200 |
| <https://docs.ntfy.sh/> | 200 |

## Connexion avec Stripe ou clé limitée ?

La **clé limitée `rk_`** est recommandée : lecture seule garantie par Stripe et aucune donnée ne quitte l'instance. **Connexion avec Stripe** est une **bêta pour comptes de test** : elle passe par le service Searchtide Connect, qui voit les données demandées et n'en conserve aucune. Si le service est indisponible, Searchtide propose la clé limitée.

## Comment connecter Supabase ?

Exécutez le bloc SQL du [guide Supabase](supabase.md) (rôle `searchtide_ro` + 4 fonctions), puis collez l'adresse **Session pooler** (port 5432) dans Connexions → Supabase. N'utilisez pas l'adresse directe `db.….supabase.co` ni le port 6543.
