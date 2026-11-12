# Contribuer à Searchtide

Merci de prendre le temps. Ce projet est maintenu sur un temps limité : les réponses se font au mieux, pas sous engagement de délai.

## Avant d'ouvrir une pull request

- **Ouvrez une issue d'abord** pour tout ce qui touche au schéma de la base, aux connecteurs, à l'authentification ou au serveur MCP. Une PR de 800 lignes sans discussion préalable a peu de chances d'être fusionnée.
- Les corrections de fautes, de documentation et les petits correctifs peuvent aller directement en PR.
- Une PR = un sujet. Pas de reformatage global mélangé à un correctif.

## Installer pour développer

Node **22.18 ou plus** (le serveur s'exécute directement en TypeScript via le type-stripping de Node).

```bash
npm install
npm run dev      # serveur sur :3030, interface Vite sur :5173
```

Sans Docker, la base est créée dans `data/`. Pour repartir de zéro : `rm -rf data/searchtide.db`.

## Vérifier avant de proposer

```bash
npm run typecheck
npm test          # tests serveur, base en mémoire
npm run build
npm run e2e       # Playwright, Chromium
```

Les quatre doivent passer. La CI les rejoue sur chaque PR.

- **Postgres** : les 8 tests réels sont ignorés en CI. Pour les jouer, lancez une base jetable et passez son URL dans `SEARCHTIDE_TEST_PG` ; les commandes exactes et le nettoyage attendu sont en commentaire en tête de `server/connectors/postgres.real.test.ts`.
- **Nouveau connecteur** : ajoutez le manifeste, le test de contrat (aucune requête qui écrit chez le fournisseur en dehors des cas déclarés) et un test du parcours « Tester ». Un connecteur sans test de contrat ne sera pas fusionné.
- **Interface** : les tests e2e tournent en Chromium uniquement. Une PR qui touche une interaction clavier ou un focus doit le mentionner, faute de quoi la vérification croisée est impossible.

## Règles non négociables

1. **Aucun secret dans le dépôt.** Ni clé, ni jeton, ni `.env`, ni `google.json`, ni capture d'écran montrant une clé. Avant de pousser : `scripts/scan-secrets.sh`.
2. **Aucune donnée personnelle** dans le code, les exemples, les migrations ou les tests : domaines réservés (`exemple.com`), identités fictives.
3. **Aucune requête qui écrit chez le fournisseur** depuis un connecteur de KPI. Les exceptions (envoi SMTP, notification ntfy) sont déclarées dans le manifeste et contrôlées par le test de contrat.
4. **Rien de personnel dans les valeurs par défaut** : pas de domaine, de compte, de marque ni de client.

Si un secret a été poussé par erreur, ne vous contentez pas de le retirer : révoquez-le, puis prévenez par le canal privé décrit dans [SECURITY.md](SECURITY.md).

## Style

- TypeScript strict, pas de `any` ajouté sans raison écrite en commentaire.
- Commentaires en français, orientés « pourquoi », pas « ce que fait la ligne ».
- Messages de commit à l'impératif, en français ou en anglais, une ligne claire puis un corps si nécessaire.
- Pas de nouvelle dépendance sans discussion : chaque paquet ajouté entre dans `docs/licences.md` et doit rester compatible MIT.

## Licence des contributions

En proposant une PR, vous acceptez que votre contribution soit publiée sous la licence MIT du projet. Aucun CLA n'est demandé.

## Ordre des vérifications

Lancer `npm run build` **avant** `npm test` : le test T24 (démarrage en production) sert la page de connexion depuis `web/dist`, et échoue si le dossier n'existe pas encore. Ensuite seulement `npm run e2e`.
