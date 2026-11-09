/**
 * Total d'une colonne : somme pour les comptes ; pour l'argent, somme seulement si toutes les lignes partagent la même devise,
 * sinon `mixed` (l'interface affiche « Devises mélangées ») ; les scores, notes, positions et durées ne se totalisent pas.
 */
export function columnTotal(kind: string, values: { value: number | null; unit: string | null }[]): { value: number | null; unit: string | null; mixed: boolean } {
  const ms = values.filter((m) => m && m.value != null);
  if (!ms.length || (kind !== "count" && kind !== "money")) return { value: null, unit: null, mixed: false };
  if (kind === "money") {
    const units = new Set(ms.map((m) => m.unit ?? "€"));
    if (units.size > 1) return { value: null, unit: null, mixed: true };
  }
  return { value: ms.reduce((n, m) => n + m.value!, 0), unit: kind === "money" ? ms[0].unit : null, mixed: false };
}
