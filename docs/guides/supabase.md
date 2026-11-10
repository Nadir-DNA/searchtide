# Supabase

Searchtide lit quatre chiffres de votre projet Supabase : **utilisateurs (total)**, **inscriptions par jour**, **connectés sur 7 / 30 jours** et **taille de la base**. Aucune Management API, aucun jeton d'organisation : un **rôle Postgres en lecture seule** et quatre fonctions d'agrégat.

## 1. Coller le bloc SQL

Dans Supabase : **SQL Editor** → coller et exécuter. Remplacez le mot de passe.

```sql
create schema if not exists searchtide;

create or replace function searchtide.users_total() returns bigint
language sql security definer set search_path = '' as $$
  select count(*) from auth.users where coalesce(is_anonymous, false) = false $$;

create or replace function searchtide.signups_on(d date) returns bigint
language sql security definer set search_path = '' as $$
  select count(*) from auth.users
  where (created_at at time zone 'utc')::date = d and coalesce(is_anonymous, false) = false $$;

create or replace function searchtide.signed_in_last(days int) returns bigint
language sql security definer set search_path = '' as $$
  select count(*) from auth.users
  where last_sign_in_at >= now() - make_interval(days => days) and coalesce(is_anonymous, false) = false $$;

create or replace function searchtide.db_size_bytes() returns bigint
language sql security definer set search_path = '' as $$
  select pg_database_size(current_database()) $$;

revoke all on schema searchtide from public;
revoke execute on all functions in schema searchtide from public;

create role searchtide_ro login password 'choisissez-un-mot-de-passe';
alter role searchtide_ro set default_transaction_read_only = on;
grant usage on schema searchtide to searchtide_ro;
grant execute on all functions in schema searchtide to searchtide_ro;
```

Si votre projet n'a pas la colonne `is_anonymous`, retirez la condition `coalesce(is_anonymous, false) = false` des trois fonctions concernées.

Le rôle **ne voit aucune table** et **jamais les adresses e-mail** : il ne peut appeler que ces fonctions.

## 2. Récupérer l'adresse (Session pooler)

Dans Supabase : bouton **Connect** → **Session pooler**. Copiez l'adresse, remplacez le mot de passe par celui du rôle.

- L'utilisateur ressemble à `searchtide_ro.<référence>` : c'est normal sur le pooler.
- **Port 5432** requis (mode session). Le port 6543 (transaction) est refusé.
- N'utilisez pas l'adresse directe `db.<référence>.supabase.co` : elle n'accepte qu'IPv6 sans option payante. Searchtide l'accepte mais affiche un avertissement.

## 3. Connecter dans Searchtide

**Connexions → Supabase → Connecter**, collez l'adresse, puis **Tester et enregistrer**. Réussite attendue : « Connecté : projet <référence>, PostgreSQL <version>, 4 indicateurs disponibles. »

## Erreurs courantes

| Message | Cause |
|---|---|
| « Supabase refuse ces identifiants… » | utilisateur `searchtide_ro.<référence>` ou mot de passe du bloc SQL incorrect |
| « Les fonctions Searchtide manquent… » | bloc SQL non exécuté ou schéma `searchtide` absent |
| « Compte trop puissant refusé… » | vous avez utilisé un rôle propriétaire ou superutilisateur |
| « Utilisez le port 5432… » | adresse en mode transaction (6543) |
| « Le projet semble en pause… » | réactivez le projet dans Supabase |

## Limites

- Pas d'activation ni de rétention : elles demandent une table d'événements propre à votre produit, à écrire avec le connecteur Postgres générique.
- Plusieurs connexions Supabase sont possibles (une par projet), avec un libellé.
