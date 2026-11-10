# Notes de version — Searchtide v0.2.1

Version corrective publiée le 10/11/2026. Elle ne change ni la structure de l'instance ni les données existantes.

## Correctifs

- **Portefeuille (B1/CA34, M1, M2)** : le CA et les nouveaux contacts saisis à la main comptent enfin. Un projet sans valeur Stripe affiche sa saisie (147 € « saisi », 92 contacts) ; Stripe ne prend la priorité que s'il fournit réellement un indicateur `revenue` ou `new_customers` **avec une valeur**. Jamais d'addition des deux sources ; devises mélangées toujours refusées.
- **Score de santé (B2/CA35, M3)** : sous 60 % de couverture **brute**, le score est partiel, neutre, avec le libellé « Partiel · N % mesuré » ; la couverture affichée est tronquée quand le score est partiel (59,6 % → 59 %), arrondie sinon.
- **Clés d'agent (B4/CA37)** : `agent_keys.read_only` vaut 1 par défaut sur une base neuve ; les clés existantes gardent leurs droits.
- **Google (B5/CA38)** : bouton **Copier** sur l'adresse du compte de service, dans l'avertissement « Aucune propriété visible » et dans l'indice de connexion, avec annonce « Copié » et repli explicite si le presse-papiers est indisponible.

## Documentation

- Nouveaux `README.md`, `CONTRIBUTING.md`, `SECURITY.md`.
- Dix guides de connecteurs dans `docs/guides/` (analytics, API JSON, FAQ, Google, ntfy, PageSpeed, Postgres, saisie manuelle, SMTP, Stripe).
- Modèles d'issue (bug, idée) et de discussion « J'ai installé » dans `.github/`.

## Installation

```bash
docker run -d --name searchtide -p 3030:3030 -v searchtide:/data ghcr.io/nadir-dna/searchtide:0.2.1
docker logs searchtide    # mot de passe administrateur généré au premier lancement
```

Mise à jour depuis 0.2.0 : remplacer l'image et redémarrer ; le volume `/data` est conservé.

## Limites connues

- OAuth Stripe (plateforme + relais central) est conçu mais **non implémenté** ; la clé restreinte `rk_` reste la seule voie.
- Les tests Postgres réels restent ignorés dans la CI (service non configuré).
- Les fournisseurs réels ne sont pas rejoués à chaque release ; la recette v0.2.0 (Stripe, SMTP, Google, ntfy) reste la référence.
- Firefox et WebKit ne sont pas couverts par les tests de bout en bout.
