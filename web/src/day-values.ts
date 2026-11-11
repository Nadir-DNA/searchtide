// Import CSV « jour,valeur » (C8) : validation stricte avant tout envoi.
// Refuse une valeur vide, une date irréelle (aller-retour Date identique) et plus de 366 lignes.

export type DayValue = { day: string; value: number };

export function parseDayValues(text: string, max = 366): { rows: DayValue[]; errors: string[] } {
  const rows: DayValue[] = [];
  const errors: string[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const s = line.trim();
    if (!s) return;
    if (i === 0 && /^jour\s*[,;\t]\s*valeur$/i.test(s)) return;
    // Tableur français : « date;4,5 ». Un point-virgule ou une tabulation l'emporte sur la virgule,
    // qui peut alors être le séparateur décimal.
    const sep = s.includes(";") ? ";" : s.includes("\t") ? "\t" : ",";
    const parts = s.split(sep);
    if (parts.length !== 2) { errors.push(`Ligne ${i + 1} : trop de colonnes (attendu jour${sep}valeur)`); return; }
    const day = parts[0].trim();
    const raw = parts[1].trim();
    const dt = /^\d{4}-\d{2}-\d{2}$/.test(day) ? new Date(`${day}T00:00:00Z`) : null;
    if (!dt || Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== day) {
      errors.push(`Ligne ${i + 1} : date invalide « ${day || s} » (attendu AAAA-MM-JJ)`);
      return;
    }
    if (raw === "") { errors.push(`Ligne ${i + 1} : valeur vide`); return; }
    if (!/^-?\d+([.,]\d+)?$/.test(raw)) { errors.push(`Ligne ${i + 1} : valeur non numérique « ${raw} »`); return; }
    rows.push({ day, value: Number(raw.replace(",", ".")) });
  });
  if (rows.length > max) return { rows: [], errors: [...errors, `${max} valeurs maximum par import`] };
  return { rows, errors };
}
