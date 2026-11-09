// Cartes « Toujours disponibles » du catalogue : rien à connecter. Elles ne contiennent ni test() utile ni collect().
import { register } from "./registry.ts";
import type { Connector } from "./types.ts";

const builtin = (c: Pick<Connector, "id" | "name" | "monogram" | "description" | "unlocks"> & Partial<Connector>): Connector => ({
  provider: "Searchtide", category: "integre", minutes: 0, builtin: true, fields: [], guide: [],
  hint: () => "Intégré", test: async () => ({ ok: true }), ...c,
});

register(builtin({
  id: "analytics", name: "Searchtide analytics", monogram: "SA",
  description: "Le suivi des visites sans cookie, déjà intégré. Ajoutez un site, collez le script, les chiffres arrivent.",
  unlocks: ["Visites", "Pages vues", "Canaux", "Part du trafic venant d'IA", "Pays", "Événements"],
}));
register(builtin({
  id: "manual", name: "Saisie manuelle", monogram: "SM",
  description: "Un chiffre que vous relevez vous-même, jour par jour : abonnés aux réseaux, demandes de support.",
  unlocks: ["Tout indicateur saisi à la main sur la page d'un projet"],
}));
