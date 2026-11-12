# Notes de version — Searchtide v0.4.0

Non publiée. Cette version borne ce qu'un agent peut faire, ajoute des approbations pour les actions irréversibles, et prépare la publication sur les réseaux sociaux.

## À lire d'abord : ce qui est simulé

- **Les publications sont simulées.** Le transport « API » est un fournisseur factice : il renvoie une adresse de preuve fictive (`https://sim.test/…`), aucun réseau n'est joint, aucun compte réel n'est connecté.
- **Le navigateur intégré n'a été éprouvé que sur des pages de test** (mode recette). Aucune connexion réelle à X, Instagram, TikTok, YouTube, LinkedIn ou Facebook n'a été vérifiée. Les conditions d'utilisation de ces réseaux restreignent l'automatisation ; Searchtide ne contourne ni CAPTCHA, ni double authentification.
- Le bac à sable de Chromium n'a été éprouvé qu'en conteneur Docker avec le profil fourni (voir le runbook).

## Clés d'agent bornées par projet

Une clé reçoit pour chaque projet un mode **lecture** ou **écriture**. REST et MCP appliquent la même règle ; une cible hors portée répond « Introuvable », comme un objet absent. Pour une clé limitée, les outils MCP sont sur **liste blanche** : tout ce qui est inter-projets (pages du tableau de bord, connexions, journal, tâches de fond, résumé CRM) est refusé. Les blocs de page qui désignent un autre projet, domaine ou indicateur sont retirés.

## Approbations

Supprimer un projet ou un indicateur avec une clé d'agent demande une approbation de l'administrateur : à usage unique, liée à la clé, au projet et à la cible. Avant toute suppression de projet (clé ou administrateur), un **instantané** de la base est écrit dans `BACKUP_DIR` (`pre-suppression-…db`, droits 600, les 5 plus récents gardés). La suppression est une cascade définitive : les indicateurs et mesures du projet disparaissent.

## Navigateur intégré (option)

Écran « Connexions navigateur » (administrateur seul) : on ouvre une page, on se connecte soi-même, la session est scellée dans le coffre à la demande. Le navigateur est le Chromium standard, sans furtivité.

**Filtre réseau.** Chromium ne sort que par un proxy local de Searchtide. Le proxy résout lui-même chaque nom, refuse toute adresse interne (boucle locale, privées, lien local, CGNAT, ULA, métadonnées, IPv4 mappée IPv6…) et se connecte à l'adresse validée : redirections, sous-ressources et rebinding DNS sont couverts. Il ne déchiffre pas le HTTPS. En conteneur, interdisez en plus la sortie vers les réseaux privés (voir le runbook).

**Mode recette.** `BROWSER_FIXTURES=1` : l'instance sert des pages de test locales et les liste dans l'écran. Sans cette variable, le port des pages de test n'est pas admis.

## Publications

Comptes par projet, brouillons, programmation (tâche d'une minute), médias, preuve. États : Brouillon, Programmé, En cours, Publié, Échec, Action requise, À vérifier, Manqué, Annulé. Une publication programmée a son contenu figé. « À vérifier » (résultat incertain, ou intention d'envoi sans preuve) se résout à la main : « Marquer publiée » avec l'adresse, ou « Remettre en brouillon ». Rien n'est jamais renvoyé automatiquement. Si le module Publications est désactivé, la file ne tourne pas (l'écran le dit).

## Mise à jour depuis 0.2.x

1. Sauvegardez `/data` (base, `secret`, `admin-password`).
2. L'image tourne en non root : `docker run --rm -v searchtide:/data alpine chown -R 1000:1000 /data` si le volume vient d'une version précédente (sans cela, le démarrage échoue sur la base).
3. Mettez à jour l'image, vérifiez `GET /healthz` (`version` 0.4.0) et lisez les journaux.
4. Les clés d'agent existantes passent en « tous projets » : réduisez leur portée dans Agents IA si besoin.

Retour arrière : voir [exploitation.md](exploitation.md).
