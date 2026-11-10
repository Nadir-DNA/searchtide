# Connecter Postgres (lecture seule)

**Temps estimé :** ~10 min · **Comptes multiples :** oui (une connexion par base) · **Lecture seule imposée par le serveur.**

Searchtide calcule un chiffre de votre base produit avec une requête `SELECT` : inscriptions, utilisateurs actifs, activation, rétention. La lecture seule n'est pas une promesse de réglage : chaque requête s'exécute dans une transaction `READ ONLY` avec un délai de 10 s.

## Ce que ça débloque

- Tout chiffre calculable en SQL : inscriptions, utilisateurs actifs, activation, rétention.
- Quatre modèles prêts à adapter : inscriptions par jour, actifs sur 7 jours, utilisateurs activés, rétention à 7 jours.

## Avant de commencer

- Une base PostgreSQL accessible depuis l'instance Searchtide (même réseau, VPN ou hôte public avec TLS).
- Un compte PostgreSQL capable de créer un rôle — pas besoin d'un superutilisateur pour Searchtide.
- Un mot de passe dédié : ne réutilisez pas celui d'un autre service.

## Étapes

1. Connectez-vous à la base avec un compte d'administration et créez un **rôle en lecture seule** :

```sql
CREATE ROLE searchtide_ro LOGIN PASSWORD 'choisissez-un-mot-de-passe';
GRANT CONNECT ON DATABASE votre_base TO searchtide_ro;
GRANT USAGE ON SCHEMA public TO searchtide_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO searchtide_ro;
```

2. Si de nouvelles tables sont créées plus tard, accordez aussi les droits par défaut (la commande s'applique aux tables créées par le rôle qui l'exécute) :

```sql
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO searchtide_ro;
```

3. Dans Searchtide : **Connexions → Postgres (lecture seule) → Connecter**, collez l'URL complète :

```
postgres://searchtide_ro:…@hote:5432/base
```

4. **« Tester et enregistrer »**. Le test vérifie la connexion, la version, que le compte **n'est pas superutilisateur**, et s'il peut écrire.
5. Sur un projet : **Sources → Rattacher → Postgres**, puis choisissez un modèle SQL et adaptez-le (`$1` = le jour pour un indicateur journalier). « Tester » affiche la valeur du jour sans rien écrire.

## Ce que vous voyez après le test

- **Réussite :** « Connecté : {base} », puis « base {base}, PostgreSQL {version}, compte {utilisateur} ».
- **Avertissement :** « Ce compte peut écrire : utilisez un compte en lecture seule (modèle dans le guide). » La connexion est enregistrée, mais le compte accorde trop de droits.
- **Refus :** « Compte superutilisateur refusé : créez un compte en lecture seule. » Aucune ligne n'est créée.

## Erreurs fréquentes

| Message affiché | Cause | Action |
|---|---|---|
| « L'URL doit ressembler à `postgres://utilisateur:motdepasse@hôte:5432/base`. » | URL incomplète ou mal encodée. | Vérifiez l'utilisateur, l'hôte, le port et le nom de la base. |
| « L'URL doit commencer par `postgres://`. » | Schéma `postgresql://` absent ou faute de frappe. | Utilisez `postgres://` ou `postgresql://`. |
| « PostgreSQL refuse ces identifiants : vérifiez l'utilisateur et le mot de passe. » | Mauvais mot de passe, rôle absent, `pg_hba.conf` restrictif. | Recréez le rôle ou corrigez le mot de passe ; vérifiez les règles d'accès. |
| « Connexion impossible à {hôte}:{port} : vérifiez l'hôte et le port. » | Hôte, port ou pare-feu. | Vérifiez l'adresse, `listen_addresses`, et les règles réseau. |
| « La base de données ne répond pas. Réessayez dans un instant. » | Délai de 10 s dépassé. | Réessayez ; sinon, vérifiez la charge de la base. |
| « Compte superutilisateur refusé : créez un compte en lecture seule. » | Le rôle est `SUPERUSER`. | Créez un rôle simple avec `GRANT SELECT`, comme ci-dessus. |
| « Permission manquante : ce compte n'a pas le droit de lire cette table (GRANT SELECT). » | Table non couverte par les droits. | Accordez `SELECT` sur la table, ou sur toutes les tables du schéma. |
| « Cette requête essaie d'écrire : seules les lectures sont acceptées. » | La requête contient une écriture. | Réécrivez-la en `SELECT`. |
| « Une seule requête SELECT est acceptée : un seul point-virgule final est toléré, aucun autre. » | Deux instructions collées, ou un `;` au milieu. | Gardez une seule instruction ; retirez le `;` intérieur. |
| « Seules les requêtes SELECT sont acceptées. » | La requête commence par `INSERT`, `UPDATE`, `CREATE`… | Utilisez `SELECT` (ou `WITH`). |
| « La requête dépasse 10 secondes et a été interrompue : simplifiez-la ou ajoutez un index. » | Requête trop lourde. | Ajoutez un index, réduisez la période, ou précalculez. |
| « La requête doit renvoyer un nombre. » | La première colonne n'est pas numérique. | Renvoyez un `COUNT`, une somme, un ratio arrondi. |

## Limites et sécurité

- Une **seule instruction** par indicateur, qui doit renvoyer **un nombre** (première colonne de la première ligne).
- La transaction est toujours `BEGIN READ ONLY` + `statement_timeout = 10s` + `ROLLBACK` : même un `SELECT` piégé ne peut pas écrire.
- Un compte **superutilisateur est refusé** ; un compte qui peut écrire est accepté mais signalé.
- PostgreSQL 14 et antérieur accordent `CREATE` sur le schéma `public` par défaut : le test se base alors sur le droit d'écrire dans les tables.
- L'URL contient le mot de passe : elle est chiffrée et n'est jamais réaffichée. L'indice affiché est `utilisateur@hôte/base`.
- Aucune migration, aucun `CREATE`, aucun `ANALYZE` n'est envoyé par Searchtide.
- Pour retirer : « Retirer » dans la carte, puis `DROP ROLE searchtide_ro;` si le rôle ne sert plus.

## Liens de ce guide

Aucun lien externe : tout se passe dans votre base et dans Searchtide.
