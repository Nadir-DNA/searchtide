// Export CSV (C2) : UTF-8 avec BOM, RFC 4180, séparateur virgule, CRLF.
// Toute cellule commençant par = + - @ est préfixée d'une apostrophe : les chemins et référents
// viennent de tiers, une feuille de calcul ne doit pas interpréter une formule.

export function csvCell(value: string | number): string {
  let s = String(value);
  if (typeof value !== "number" && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

export function csvText(rows: (string | number)[][]): string {
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}
