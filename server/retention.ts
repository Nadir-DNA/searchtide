// C9 / 13.5-B : rétention et purge des événements, un site par appel, avec garde-fous.
// Ne touche QUE les lignes de `events` strictement antérieures à `before` ; jamais gsc_rows, sites ou autres tables.
import { db, localDay } from "./db.ts";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const shift = (day: string, days: number) => new Date(Date.parse(day + "T00:00:00Z") + days * 86_400_000).toISOString().slice(0, 10);

export function countEventsBefore({ siteId, before }: { siteId: string; before: string }): number {
  if (!DAY.test(before)) throw new Error("Date au format AAAA-MM-JJ attendue");
  return (db.prepare("SELECT COUNT(*) AS n FROM events WHERE site_id = ? AND day < ?").get(siteId, before) as { n: number }).n;
}

export type Purge = { count: number; deleted: number };

/**
 * Supprime les événements du site strictement antérieurs à `before`.
 * Refuse une date de moins de 30 jours et un décompte `expect` périmé (409 côté API).
 * `dryRun` compte sans supprimer.
 */
export function purgeEventsBefore({ siteId, before, expect, dryRun = false }: { siteId: string; before: string; expect: number; dryRun?: boolean }): Purge {
  if (!DAY.test(before)) throw new Error("Date au format AAAA-MM-JJ attendue");
  const oldest = shift(localDay(), -30);
  if (before > oldest) throw new Error(`Choisissez une date au plus tard le ${oldest} (au moins 30 jours avant aujourd'hui)`);
  const count = countEventsBefore({ siteId, before });
  if (count !== expect) { const e = new Error(`Le décompte a changé (${count} au lieu de ${expect}) : recommencez`); (e as Error & { status: number }).status = 409; throw e; }
  if (dryRun) return { count, deleted: 0 };
  db.exec("BEGIN");
  try {
    const r = db.prepare("DELETE FROM events WHERE site_id = ? AND day < ?").run(siteId, before);
    db.exec("COMMIT");
    return { count, deleted: Number(r.changes) };
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}
