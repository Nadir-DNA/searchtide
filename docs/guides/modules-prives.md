# Modules privés

Un module privé ajoute à votre instance une capacité qui n'a pas sa place dans Searchtide : la base d'un produit à vous, un service interne, des chiffres propres à votre activité. Il se comporte exactement comme un module livré. Il s'active dans **Modules**, puis projet par projet, et apporte ses KPI, ses onglets, ses blocs et ses outils pour les agents.

## Installer

1. Créez un dossier hors du dépôt Searchtide, par exemple `~/searchtide-prive/`.
2. Indiquez-le dans `.env` : `PLUGINS_DIR=/chemin/vers/searchtide-prive`.
3. Redémarrez. Le journal indique `[modules privés] chargés : …`, ou la raison d'un refus.

Un module refusé n'empêche pas le serveur de démarrer : il est simplement absent, et la raison est écrite dans le journal.

## Écrire un module

Un fichier `.ts` par module. Il exporte par défaut le manifeste du module, et, s'il en a besoin, la liste de ses connecteurs (`connectors`) :

```ts
// ~/searchtide-prive/exemple.ts
export const connectors = [{
  id: "exemple-db", name: "Base d'exemple", provider: "La base d'exemple", monogram: "PL",
  description: "Lecture seule de la base de production.", category: "produit", minutes: 5,
  unlocks: ["Réservations par jour", "Salons actifs"],
  fields: [{ key: "url", label: "URL Postgres en lecture seule", type: "url", secret: true, required: true }],
  guide: [{ text: "Créez un rôle en lecture seule (voir acces-exemple.sql)." }],
  hint: () => "base d'exemple",
  test: async (cfg, ctx) => ({ ok: true }),
  kpis: [{ id: "bookings", label: "Réservations par jour", mode: "daily" }],
  toIndicator: (kpi) => ({ source: "pg", config: { sql: "SELECT COUNT(*) FROM bookings WHERE created_at::date = $1" } }),
}];

export default {
  id: "exemple", name: "Exemple", category: "produit", scope: "projet", connectors: ["exemple-db"],
  description: "Réservations et salons actifs de exemple.test.",
};
```

Les champs du manifeste sont ceux de `server/modules/types.ts` (module) et `server/connectors/types.ts` (connecteur). Chaque module passe la même vérification que les modules livrés (`checkModule`) : identifiant, catégorie, portée, connecteurs connus, blocs non déclarés ailleurs.

Ce qu'un module peut apporter :

| Champ | Effet |
|---|---|
| `tabs` | onglets de la page d'un projet |
| `widgets` | blocs ajoutables aux pages |
| `mcp(server, { readOnly, agent })` | outils pour les agents, enregistrés seulement si le module est actif |
| `jobs` | tâches de fond (`every` : `30m`, `6h`, `daily@02:30`), visibles dans Réglages |
| `actions(projectId)` | lignes proposées dans le fil « Aujourd'hui » |
| `kpis(projectId)` | KPI proposés dans « Ajouter des KPI » |

## Exemple d'usage

Un module privé peut viser les spécificités de votre activité (organisation Stripe, bases internes, veille). Le reste du code est celui de Searchtide, sans modification. Le dossier privé n'est jamais publié.
