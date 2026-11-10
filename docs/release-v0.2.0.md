# Notes de version — Searchtide v0.2.0

**Statut : préparées, non publiées.** Le tag `v0.2.0` et la publication GitHub restent à faire par Nadir, après le push de `main`.

## En une phrase

Searchtide passe d'un tableau de bord à configurer dans `.env` à un produit auto-hébergé qui se lance en une commande et se branche à vos services depuis l'interface.

## À essayer en premier

```bash
docker run -d -p 3030:3030 -e DEMO=1 -v searchtide_demo:/data ghcr.io/nadir-dna/searchtide:0.2.0
# http://localhost:3030 — données fictives, lecture seule
```

Installation réelle, sans clé ni fichier à éditer :

```bash
docker run -d --name searchtide -p 3030:3030 -v searchtide:/data ghcr.io/nadir-dna/searchtide:0.2.0
docker logs searchtide    # mot de passe administrateur généré au premier lancement
```

## Nouveautés

- **Sept connecteurs** dans une interface unique : Stripe (clé restreinte en lecture), SMTP, Gmail, ntfy, Google Search Console + Play, Postgres en lecture seule, PageSpeed. Plus l'API JSON et la saisie manuelle.
- **Secrets chiffrés** (AES-256-GCM), jamais réaffichés, migration des anciens jetons, rotation de `SECRET` gérée.
- **Score de santé** et **vue Portefeuille** multi-projets, avec colonnes au choix conservées et total prudent sur les devises.
- **Onboarding** en quatre étapes et sources rattachées aux projets.
- **Démonstration** avec données fictives, captures prêtes pour le README.
- **Installation en une commande** : `SECRET` et mot de passe générés, affichés une fois, conservés dans le volume.
- **CI** sur chaque PR, image multi-arch prête pour GHCR, inventaire de licences, scan de secrets.

## Corrections

- Réglages réservés à l'administrateur (clé d'API et agents MCP n'y ont plus accès).
- Postgres : un point-virgule final toléré ; plusieurs instructions toujours refusées.
- Focus de la confirmation de retrait (course Chromium).

## Compatibilité et limites

- Node 22.18 ou plus (mode type-stripping), SQLite intégré ; image Docker `node:22-alpine`.
- Linux `amd64` et `arm64` pour l'image.
- Fournisseurs réels non validés par une recette publique à ce stade ; tests sur simulations.
- Pas de Firefox/WebKit dans les tests e2e.
- Les installations existantes doivent définir `SECRET` et `ADMIN_PASSWORD` comme avant (ou laisser la génération le faire si les fichiers sont absents).

## Après le tag (à faire par Nadir)

1. **Déplacer `.env` et `google.json` hors du dépôt (T33)**, puis pousser `main`. Le scan de secrets de l'arbre et de tout l'historique est fait ; le déplacement de ces fichiers ne l'est pas encore.
2. Créer le tag annoté `v0.2.0` : `git tag -a v0.2.0 -m "Searchtide v0.2.0" && git push origin v0.2.0` (utiliser `-s` seulement si une clé GPG est configurée).
3. Vérifier que le workflow « Image Docker » pousse bien `ghcr.io/nadir-dna/searchtide:0.2.0` et `:latest` pour les deux architectures. Nom confirmé par Nadir (Q-N11) : `ghcr.io/nadir-dna/searchtide` (le workflow suit `github.repository`).
4. Publier ces notes comme release GitHub (copier ce fichier).

## Données de l'instance

Le volume `/data` contient la base SQLite, mais aussi `secret` (clé du coffre) et `admin-password` (mot de passe généré), en clair et en droits 600. **Sauvegarder tout `/data`** : une base restaurée sans `secret` rend les connexions indéchiffrables. La sauvegarde nocturne inclut ces deux fichiers ; la sauvegarde hors site envoie un bundle complet (`.bundle.json.gz`) avec la base et les deux fichiers. Restauration : `node scripts/restore-backup.mjs <bundle> /data` puis redémarrage. Ne jamais joindre le volume ou le bundle à un ticket ou à une archive de support. Mot de passe perdu : supprimer `admin-password` et redémarrer (une variable `ADMIN_PASSWORD` reste prioritaire).
