// Point 1 : fraîcheur mesurée sur la DERNIÈRE DONNÉE (pas le dernier essai).
// ok / périmé / en erreur / jamais reçu. Projet en pause et module inactif : aucun élément.
import { db } from "./db.ts";
import { enabledFor, indicatorModule } from "./modules/state.ts";
import { migrate } from "./migrations.ts";
import { maskUrlSecrets } from "./mask.ts";

// La colonne vient de la collecte ; on garantit le schéma même dans les tests qui n'importent pas collect.ts.
if (!db.prepare("PRAGMA table_info(sites)").all().some((c) => (c as { name: string }).name === "last_hit")) {
  migrate("2026-11-10-derniere-visite", "ALTER TABLE sites ADD COLUMN last_hit INTEGER");
}

export type FreshState = "ok" | "stale" | "error" | "never";
export type FreshItem = {
  key: string; project_id: string; kind: "tracker" | "gsc" | "indicator";
  label: string; state: FreshState; lastData: string | null; thresholdDays: number; detail: string;
};

const DAY = 86_400_000;
const daysSince = (now: number, day: string) => (now - Date.parse(`${day}T00:00:00Z`)) / DAY;
const stateOf = (now: number, day: string | null, threshold: number): FreshState =>
  !day ? "never" : daysSince(now, day) > threshold ? "stale" : "ok";

export function freshness(now = Date.now()): FreshItem[] {
  const out: FreshItem[] = [];
  const projects = db.prepare("SELECT id, name, sites FROM projects WHERE paused = 0 ORDER BY position, name").all() as { id: string; name: string; sites: string }[];
  for (const p of projects) {
    for (const domain of JSON.parse(p.sites) as string[]) {
      const site = db.prepare("SELECT id, domain, last_hit, gsc_property FROM sites WHERE domain = ?").get(domain) as { id: string; domain: string; last_hit: number | null; gsc_property: string | null } | undefined;
      if (!site) continue;
      const lastHitDay = site.last_hit ? new Date(site.last_hit).toISOString().slice(0, 10) : null;
      out.push({ key: `tracker:${site.id}`, project_id: p.id, kind: "tracker", label: `${p.name} · suivi ${site.domain}`,
        state: stateOf(now, lastHitDay, 2), lastData: lastHitDay, thresholdDays: 2,
        detail: lastHitDay ? "dernière visite reçue" : "aucune visite reçue" });
      if (site.gsc_property) {
        const g = db.prepare("SELECT last_day FROM gsc_syncs WHERE site_id = ?").get(site.id) as { last_day: string | null } | undefined;
        out.push({ key: `gsc:${site.id}`, project_id: p.id, kind: "gsc", label: `${p.name} · Search Console ${site.domain}`,
          state: stateOf(now, g?.last_day ?? null, 4), lastData: g?.last_day ?? null, thresholdDays: 4,
          detail: g?.last_day ? "données Google jusqu'au jour indiqué" : "aucune donnée importée" });
      }
    }
    const inds = db.prepare("SELECT id, label, mode, source, config, last_error, stale_after_days FROM indicators WHERE project_id = ? AND archived_at IS NULL").all(p.id) as { id: string; label: string; mode: string; source: string; config: string; last_error: string | null; stale_after_days: number | null }[];
    for (const ind of inds) {
      if (ind.source === "formula") continue;
      if (ind.source === "manual" && !ind.stale_after_days) continue;
      const mod = indicatorModule({ source: ind.source, config: JSON.parse(ind.config) });
      if (!enabledFor(p.id, mod)) continue;
      let last: string | null = null;
      try {
        if (ind.source === "site") {
          const cfg = JSON.parse(ind.config) as { domain?: string };
          last = (db.prepare("SELECT MAX(day) AS d FROM events WHERE day IS NOT NULL AND site_id = (SELECT id FROM sites WHERE domain = ?)").get(cfg.domain ?? "") as { d: string | null } | undefined)?.d ?? null;
        } else {
          last = (db.prepare("SELECT MAX(day) AS d FROM metrics WHERE indicator_id = ?").get(ind.id) as { d: string | null } | undefined)?.d ?? null;
        }
      } catch { last = null; }
      const threshold = ind.source === "stripe" ? 2 : (ind.stale_after_days ?? 2);
      const state: FreshState = ind.last_error ? "error" : stateOf(now, last, threshold);
      out.push({ key: `indicator:${ind.id}`, project_id: p.id, kind: "indicator", label: `${p.name} · ${ind.label}`,
        state, lastData: last, thresholdDays: threshold,
        detail: ind.last_error ? `relevé en échec : ${maskUrlSecrets(ind.last_error)}` : last ? "dernière valeur reçue" : "aucune valeur" });
    }
  }
  return out;
}
