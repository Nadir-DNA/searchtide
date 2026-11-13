// Mise en forme commune des mesures du portefeuille (mur de projets, page d'un projet).
import { fmt } from "./ui";

export type Measure = { value: number | null; previous: number | null; unit: string | null; manual?: boolean };
export type MeasureKind = "count" | "money" | "score" | "rating" | "position" | "seconds" | "ratio" | "percent";
export type Column = { key: string; label: string; kind: MeasureKind; lowerIsBetter?: boolean };

export function formatMeasure(m: Measure | undefined, kind: MeasureKind): string {
  if (!m || m.value == null) return "—";
  const v = m.value;
  if (kind === "money") return `${fmt(v, Math.abs(v) < 100 && v % 1 ? 2 : 0)} ${m.unit ?? "€"}`;
  if (kind === "rating" || kind === "position" || kind === "percent") return `${fmt(v, 1)}${kind === "percent" ? " %" : ""}`;
  if (kind === "ratio") return fmt(v, 3);
  if (kind === "seconds") return `${fmt(v, 2)} s`;
  return fmt(v, Math.abs(v) < 100 && v % 1 ? 1 : 0);
}

/** Ce que chaque mesure absente invite à brancher ; sert aux emplacements « Connecter » du mur. */
export const SOURCE_HINT: Record<string, { label: string; action: string; to: Record<string, string> }> = {
  clicks: { label: "Clics Google", action: "Connecter Google", to: { view: "modules", open: "google" } },
  revenue: { label: "Chiffre d'affaires", action: "Connecter Stripe", to: { view: "modules", open: "stripe" } },
  leads: { label: "Nouveaux contacts", action: "Activer les contacts", to: { view: "modules" } },
};

/** Ordre dans lequel les mesures disponibles sont proposées en grand (une seule) puis en grille. */
export const HEADLINE = ["revenue", "mrr", "visitors", "clicks", "leads"] as const;
export const GRID = ["visitors", "clicks", "impressions", "position", "revenue", "mrr", "leads", "pipeline", "followups", "ai_visitors", "published", "pageviews"] as const;
