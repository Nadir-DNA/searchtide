// Score de santé par projet (04-produit §6) : 0 à 100, calculé sur la période choisie et comparé à la période précédente de même durée.
// Cinq composantes pondérées ; seules celles qui sont MESURÉES entrent dans le score (renormalisation) ; la couverture dit quelle part
// du poids applicable a pu être mesurée. Une composante est « non applicable » quand son module n'existe pas sur l'instance (Action sans CRM).
import type { Context, Hono } from "hono";
import { isAdmin } from "./admin.ts";
import { db } from "./db.ts";

export type Key = "trend" | "goals" | "reliability" | "conversion" | "action";
export type Weights = Record<Key, number>;
export const DEFAULT_WEIGHTS: Weights = { trend: 30, goals: 25, reliability: 20, conversion: 15, action: 10 };
export const LABELS: Record<Key, string> = { trend: "Tendance", goals: "Objectifs", reliability: "Fiabilité des données", conversion: "Conversion", action: "Action" };
const KEYS = Object.keys(DEFAULT_WEIGHTS) as Key[];

type Pair = { now: number | null; before: number | null } | undefined;
export type Inputs = {
  /** Mesures de tendance : visites, clics, CA net, MRR. */
  trend: { visits?: Pair; clicks?: Pair; revenue?: Pair; mrr?: Pair };
  /** Objectifs du projet et ceux dont la projection atteint la cible. */
  goals: { total: number; reached: number };
  /** Éléments suivis (indicateurs, sites, imports Search Console, connexions) et ceux en erreur. */
  reliability: { items: number; errors: number };
  /** Conversion globale de l'entonnoir (dernière étape ÷ première), période et période précédente. */
  conversion: { steps: number; now: number | null; before: number | null } | null;
  /** Relances en retard ; null si le projet n'a pas de clé de contacts. */
  action: { late: number } | null;
};
export type Part = { key: Key; label: string; weight: number; applicable: boolean; measured: boolean; value: number | null; why: string | null };
export type Health = { score: number | null; coverage: number; tone: "positive" | "warn" | "negative" | "none"; partial: boolean; missing: string[]; parts: Part[] };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** 50 = stable ; 100 = au moins doublé ; 0 = tombé à zéro (variation bornée à ±100 %). */
const fromChange = (now: number, before: number) => 50 + 50 * clamp((now - before) / before, -1, 1);

export function computeHealth(inp: Inputs, weights: Weights = DEFAULT_WEIGHTS, opts: { crm: boolean } = { crm: true }): Health {
  const w = (k: Key) => Math.max(0, Number(weights[k]) || 0);
  const parts: Part[] = [];
  const add = (key: Key, applicable: boolean, value: number | null, why: string | null) =>
    parts.push({ key, label: LABELS[key], weight: w(key), applicable, measured: applicable && value != null, value: applicable && value != null ? value : null, why: applicable && value == null ? why : !applicable ? "Non applicable sur cette instance" : null });

  const changes = Object.values(inp.trend).filter((p): p is NonNullable<Pair> => !!p && p.now != null && p.before != null && p.before > 0).map((p) => fromChange(p.now!, p.before!));
  add("trend", true, changes.length ? changes.reduce((a, b) => a + b, 0) / changes.length : null, "Aucune mesure (visites, clics, CA net, MRR) avec une période précédente supérieure à zéro");
  add("goals", true, inp.goals.total > 0 ? (100 * inp.goals.reached) / inp.goals.total : null, "Aucun objectif défini");
  add("reliability", true, inp.reliability.items > 0 ? 100 * (1 - inp.reliability.errors / inp.reliability.items) : 100, null);
  const c = inp.conversion;
  add("conversion", true, c && c.steps >= 2 && c.now != null && c.before != null && c.before > 0 ? fromChange(c.now, c.before) : null, "Entonnoir de moins de 2 étapes, ou conversion de la période précédente nulle");
  add("action", opts.crm, inp.action ? Math.max(0, 100 - 20 * inp.action.late) : null, "Aucune clé de contacts pour ce projet");

  const applicableW = parts.filter((p) => p.applicable).reduce((n, p) => n + p.weight, 0);
  const measuredW = parts.filter((p) => p.measured).reduce((n, p) => n + p.weight, 0);
  const sum = parts.filter((p) => p.measured).reduce((n, p) => n + p.weight * p.value!, 0);
  const score = measuredW > 0 ? Math.round(sum / measuredW) : null;
  const coverage = applicableW > 0 ? Math.round((100 * measuredW) / applicableW) : 0;
  // B2 : sous 60 % de couverture, le score est partiel et neutre (il ne récompense pas le vide).
  const partial = coverage < 60;
  const tone = score == null || partial ? "none" : score >= 70 ? "positive" : score >= 40 ? "warn" : "negative";
  const missing = parts.filter((p) => p.applicable && !p.measured).map((p) => p.label);
  return { score, coverage, tone, partial, missing, parts };
}

// ── Poids enregistrés (settings.health.weights), communs à tous les projets ──
db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)");
const KEY = "health.weights";

export function getWeights(): Weights {
  try {
    const raw = JSON.parse((db.prepare("SELECT value FROM settings WHERE key = ?").get(KEY) as { value: string } | undefined)?.value ?? "{}");
    return Object.fromEntries(KEYS.map((k) => [k, Number.isFinite(Number(raw[k])) && raw[k] !== null && raw[k] !== "" ? clamp(Number(raw[k]), 0, 100) : DEFAULT_WEIGHTS[k]])) as Weights;
  } catch { return { ...DEFAULT_WEIGHTS }; }
}

/** Valide 5 nombres de 0 à 100 ; la somme n'est pas imposée (le score est renormalisé). */
export function parseWeights(input: unknown): Weights | string {
  if (!input || typeof input !== "object") return "Poids manquants";
  const out = {} as Weights;
  for (const k of KEYS) {
    const raw = (input as Record<string, unknown>)[k];
    const v = typeof raw === "string" ? Number(raw.replace(",", ".")) : Number(raw);
    if (raw === undefined || raw === null || raw === "" || !Number.isFinite(v) || v < 0 || v > 100) return `${LABELS[k]} : un nombre de 0 à 100 est attendu.`;
    out[k] = v;
  }
  return out;
}
export function setWeights(w: Weights) {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(KEY, JSON.stringify(w));
}

export const crmApplicable = () => process.env.DEMO !== "1";

const forbidden = (c: Context) => c.json({ error: "Réservé à l'administrateur : connectez-vous avec le mot de passe de l'instance." }, 403);
export function registerHealth(app: Hono, preview: (days: number, weights: Weights) => { id: string; name: string; health: Health }[]) {
  app.get("/api/health/weights", (c) => c.json({ weights: getWeights(), defaults: DEFAULT_WEIGHTS, labels: LABELS }));
  app.put("/api/health/weights", async (c) => {
    if (!isAdmin(c)) return forbidden(c);
    const body = await c.req.json().catch(() => ({}));
    const w = parseWeights(body.weights ?? body);
    if (typeof w === "string") return c.json({ error: w }, 400);
    setWeights(w);
    return c.json({ weights: w });
  });
  // Aperçu en direct : scores recalculés avec des poids non enregistrés
  app.post("/api/health/preview", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const w = parseWeights(body.weights ?? body);
    if (typeof w === "string") return c.json({ error: w }, 400);
    const days = Math.min(Math.max(Number(c.req.query("days")) || 28, 1), 500);
    return c.json({ projects: preview(days, w).map((p) => ({ id: p.id, name: p.name, score: p.health.score, coverage: p.health.coverage, tone: p.health.tone })) });
  });
}
