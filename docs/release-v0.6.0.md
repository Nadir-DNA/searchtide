# Notes de version — Searchtide v0.6.0

Cette version ajoute le SEO complet, la publication façon Postiz, un assistant IA, les visuels et vidéos, l'équipe et le rapport client en marque blanche. Le détail est dans le [CHANGELOG](../CHANGELOG.md).

## À lire d'abord

- **Une grande partie de cette version parle à des services extérieurs** : Google (Search Console, inspection d'URL, Analytics 4, Business Profile), IndexNow, les réseaux sociaux, WordPress et les fournisseurs d'IA. Ces appels ont été testés avec des réponses simulées. **Validez-les sur vos propres comptes avant d'en dépendre.**
- **Les recettes de publication par navigateur** (X, LinkedIn, Facebook, Instagram, TikTok, YouTube, Pinterest, Reddit) n'ont pas encore été essayées sur de vrais comptes. Le repli par le navigateur s'active compte par compte, avec un avertissement sur les conditions d'utilisation des réseaux.
- **Rien à migrer à la main.** Les migrations de base s'appliquent au démarrage. Faites tout de même une sauvegarde de `/data` avant la mise à jour.
- **Les fonctions d'IA sont facultatives.** L'assistant, les brouillons d'articles, la visibilité dans les IA et les diapositives rédigées demandent votre clé Claude, ChatGPT ou Gemini, ou un modèle local Ollama (Connexions → Intelligence artificielle). Les appels sont facturés par le fournisseur, à l'usage.

## SEO

- **Mots-clés et Search Console** : mots-clés suivis par site, diagnostics, alerte de recul.
- **Vérifications** : vérificateur de page, générateurs de robots.txt et de données structurées.
- **Indexation** : état chez Google, signalement IndexNow.
- **Audit technique** : un robot parcourt jusqu'à 200 pages et classe les problèmes par trafic.
- **Plan d'action** : dans « À traiter ».
- **Concurrents** : votre page comparée aux leurs.
- **Articles** : briefs à partir de Search Console, brouillons rédigés par l'IA, envoi dans WordPress.
- **Visibilité dans les IA** : vos questions types posées chaque semaine aux IA connectées.
- **Google** : connecteur Google Analytics 4 ; avis et actions des fiches Google Business Profile.

## Publication

- **Plusieurs comptes** : une version et un aperçu par réseau.
- **Statistiques** : abonnés et chiffres de chaque publication.
- **Nouveaux réseaux** : Pinterest, Reddit et Google Business Profile.
- **Suites** : fils, premier commentaire, hashtags retenus par projet.
- **Automatisations** : publications répétées, flux RSS, meilleurs créneaux, webhooks signés, actions sur seuil.
- **Navigateur** : repli par le navigateur intégré, compte « Agent IA » publié par votre propre agent (par exemple Claude dans Chrome).
- **Visuels et vidéos** : carrousels et diaporamas vidéo aux couleurs du projet.

## Travail à plusieurs

- **Équipe** : comptes nominatifs, rôle administrateur ou membre en lecture seule (Réglages → Équipe).
- **Rapport client en marque blanche** : partagé par un lien secret révocable, imprimable en PDF (Projet → Réglages).
- **Assistant « Demander »** : questions sur vos données, en lecture seule, avec les sources consultées.

## Nouvelles variables, toutes facultatives

`PINTEREST_CLIENT_ID` et `PINTEREST_CLIENT_SECRET`, `REDDIT_CLIENT_ID` et `REDDIT_CLIENT_SECRET`, `GOOGLE_BUSINESS_CLIENT_ID` et `GOOGLE_BUSINESS_CLIENT_SECRET`, `TIKTOK_STATS=1`, `FFMPEG_PATH`. Voir `.env.example` et l'écran Connexions, qui donne la marche à suivre pour chaque application développeur.

Pour les vidéos, l'image avec navigateur (`WITH_BROWSER=1`, `docker-compose.browser.yml`) inclut désormais ffmpeg.

## Mise à jour d'une instance Docker

1. **Sauvegardez** :

```bash
docker run --rm -v searchtide:/data -v "$PWD":/out alpine tar czf /out/searchtide-data-avant-0.6.0.tgz -C /data .
```

2. **Mettez à jour l'image** (adaptez le nom du service si besoin) :

```bash
SEARCHTIDE_IMAGE=ghcr.io/nadir-dna/searchtide:0.6.0 docker compose pull
SEARCHTIDE_IMAGE=ghcr.io/nadir-dna/searchtide:0.6.0 docker compose up -d
```

3. **Vérifiez** : `curl -fs http://127.0.0.1:3030/healthz` doit répondre `"version":"0.6.0"`, puis lisez `docker compose logs searchtide`.
4. Vérifiez que `PUBLIC_URL` (par exemple `https://stats.nadirdaoudi.com`) est défini. Les retours OAuth des réseaux et les médias envoyés par lien en dépendent.

**Retour arrière** : arrêtez, restaurez la sauvegarde de `/data`, relancez avec `SEARCHTIDE_IMAGE=ghcr.io/nadir-dna/searchtide:0.5.0`. Ne repartez pas sur 0.5.0 avec une base déjà migrée sans l'avoir restaurée.
