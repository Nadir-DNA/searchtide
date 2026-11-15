// Découpe d'un long texte en fil (plan D6) : par paragraphes, puis phrases, puis mots, chaque partie numérotée « 1/3 ».
// Partagé par le compositeur et les tests serveur.
export function splitThread(text: string, max: number): string[] {
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length <= max) return [clean];
  const room = max - 6; // place pour « 12/12 » et une espace
  const pieces = clean.split(/\n{2,}/).flatMap((para) => para.length <= room ? [para] : para.split(/(?<=[.!?…])\s+/))
    .flatMap((s) => s.length <= room ? [s] : s.split(/\s+/).reduce<string[]>((acc, w) => {
      const last = acc[acc.length - 1];
      if (last !== undefined && (last + " " + w).length <= room) acc[acc.length - 1] = last + " " + w;
      else for (let i = 0; i < Math.max(w.length, 1); i += room) acc.push(w.slice(i, i + room));
      return acc;
    }, []));
  const parts: string[] = [];
  for (const p of pieces) {
    const last = parts[parts.length - 1];
    if (last !== undefined && (last + "\n\n" + p).length <= room) parts[parts.length - 1] = last + "\n\n" + p;
    else parts.push(p);
  }
  return parts.map((p, i) => `${p} ${i + 1}/${parts.length}`);
}
