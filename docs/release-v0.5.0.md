# Notes de version — Searchtide v0.5.0

Cette version change l'interface, ajoute des KPI, un module Rendez-vous et la publication réelle sur les réseaux.

## À lire d'abord

- **La publication réelle (LinkedIn, X, Facebook, Instagram, TikTok, YouTube) est livrée mais doit être validée sur vos propres comptes** avant d'en dépendre. Chaque réseau demande votre propre application développeur et certains en valident l'usage.
- **Rien à migrer à la main.** Les migrations de base s'appliquent au démarrage. Faites tout de même une sauvegarde de `/data` avant la mise à jour.
- Les anciennes adresses (`?view=today`, `?view=projects`, `?view=portfolio`) fonctionnent toujours. L'accueil (`/`) est désormais le **mur de projets** ; l'ancien fil « Aujourd'hui » s'appelle « À traiter ».

## Nouvelle interface

- Navigation en haut : un onglet par projet, avec un voyant de fraîcheur de ses sources (vert : à jour, orange : en retard, rouge : un relevé en erreur). Sur mobile, une barre en bas.
- Accueil en mur de projets : totaux du portefeuille, une tuile par projet (état, chiffre principal, courbe, six chiffres clés, prochaine action), puis les actions à traiter.
- Thème sombre plus contrasté, grands chiffres en chasse fixe, variations toujours doublées d'une flèche et d'un signe.
- Une source absente affiche « — » et un lien pour la connecter, jamais un faux zéro.

## Nouveaux KPI

Disponibles en colonnes du tableau « Tous les projets », sur le mur et sur la page d'un projet : pages vues, visites venues des IA, impressions Google, taux de clic, montant en négociation, relances à faire, publications publiées. Une mesure sans source n'apparaît pas.

## Rendez-vous et agenda

Un lien de réservation public par type de rendez-vous, créneaux selon vos horaires, invitation `.ics`, Google Agenda par le relais Searchtide Connect ou CalDAV. Voir le CHANGELOG pour le détail.

## Mise à jour d'une instance Docker

1. **Sauvegardez** :

```bash
docker run --rm -v searchtide:/data -v "$PWD":/out alpine tar czf /out/searchtide-data-avant-0.5.0.tgz -C /data .
```

2. **Mettez à jour l'image** (adaptez le nom du service si besoin) :

```bash
SEARCHTIDE_IMAGE=ghcr.io/nadir-dna/searchtide:0.5.0 docker compose pull
SEARCHTIDE_IMAGE=ghcr.io/nadir-dna/searchtide:0.5.0 docker compose up -d
```

3. **Vérifiez** : `curl -fs http://127.0.0.1:3030/healthz` doit répondre `"version":"0.5.0"`, puis lisez `docker compose logs searchtide`.
4. Si l'instance est publique, vérifiez que `PUBLIC_URL` (par exemple `https://stats.nadirdaoudi.com`) est défini : les retours OAuth des réseaux en dépendent.

**Retour arrière** : arrêtez, restaurez la sauvegarde de `/data`, relancez avec `SEARCHTIDE_IMAGE=ghcr.io/nadir-dna/searchtide:0.4.0`. Les migrations de cette version ne sont pas conçues pour être rejouées à l'envers : ne repartez pas sur 0.4.0 avec une base déjà migrée sans la restaurer.
