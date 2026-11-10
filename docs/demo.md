# Démonstration (T29)

Une instance de démonstration se lance en **une commande**, sans compte, sans clé et sans fichier à éditer. Elle contient
uniquement des **données fictives**, créées automatiquement au premier démarrage : deux sites sur des domaines réservés
(`exemple.com`, `exemple-boutique.com`), 60 jours de visites et des données Search Console simulées.

## Docker

```bash
docker run -d --name searchtide-demo -p 127.0.0.1:3030:3030 -e DEMO=1 -v searchtide_demo:/data ghcr.io/nadir-dna/searchtide:0.2.0
# http://localhost:3030
```

Image pas encore publiée : construire d'abord, puis lancer la même commande avec `searchtide` à la place de l'image GHCR.

## Sans Docker

```bash
npm run demo        # http://localhost:3030, base data/demo.db
```

## Ce que fait `DEMO=1`

- Lecture ouverte à tous, **écriture toujours protégée** par mot de passe ; ni CRM, ni prospection, ni gestion des connexions.
- Les données fictives ne sont créées que si la base ne contient aucun site : un redémarrage ne duplique rien.
- Pour repartir de zéro, supprimer le volume (`docker volume rm searchtide_demo`) ou `data/demo.db`.

## Captures pour le README

| Fichier | Contenu |
|---|---|
| [`docs/demo.png`](demo.png) | Vue d'ensemble (visites, pages vues, trafic venu d'assistants IA, clics Google) |
| [`docs/demo-portefeuille.png`](demo-portefeuille.png) | Portefeuille multi-projets |

Régénérer après une modification de l'interface :

```bash
docker run -d --name st-demo -p 127.0.0.1:3030:3030 -e DEMO=1 -v st-demo:/data <image>
node scripts/capture-demo.mjs http://127.0.0.1:3030
```

Aucune donnée réelle n'est utilisée : les valeurs sont générées par `server/demo-data.ts` avec une graine fixe (résultat stable).
