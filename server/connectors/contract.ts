// Contrat commun à tous les connecteurs (CA15), vérifié par les tests : manifeste valide, test() et collect() en lecture seule
// chez le fournisseur (GET, ou POST déclarés dans readPosts, ou effet de bord déclaré), aucun secret dans les journaux,
// aucune écriture en base, indice (hint) sans secret entier.
import { db } from "../db.ts";
import { secretValues } from "../vault.ts";
import { realCtx } from "./registry.ts";
import type { Cfg, Connector, Ctx, Kpi, Mailer, PgPoolLike } from "./types.ts";

/** Données de simulation d'un connecteur (jamais de vrai fournisseur). */
export type Fixture = {
  cfg: Cfg;
  /** Réponse simulée du fournisseur à une requête HTTP. */
  respond?: (url: string, init: RequestInit) => Response | Promise<Response>;
  /** Paramètres à fournir par KPI pour collect(). */
  params?: Record<string, Record<string, any>>;
  /** Réponse simulée d'une requête SQL. */
  sql?: (sql: string) => any[];
  /** Le test() doit-il réussir ? (par défaut oui) */
  expectOk?: boolean;
};

export type Seen = { http: { method: string; url: string }[]; mails: number; sql: string[]; logs: string[] };

/** Contexte simulé qui enregistre tout ce que le connecteur essaie de faire. */
export function recordingCtx(fx: Fixture): { ctx: Ctx; seen: Seen } {
  const seen: Seen = { http: [], mails: 0, sql: [], logs: [] };
  const mailer: Mailer = { verify: async () => true, sendMail: async () => { seen.mails++; return {}; } };
  const pool: PgPoolLike = {
    connect: async () => ({ query: async (sql: string) => { seen.sql.push(sql); return { rows: fx.sql ? fx.sql(sql) : [] }; }, release() {} }),
    end: async () => {},
  };
  const ctx = realCtx({
    now: () => new Date("2026-11-09T10:00:00Z"),
    fetch: (async (u: any, i: RequestInit = {}) => {
      const url = String(u);
      seen.http.push({ method: (i.method ?? "GET").toUpperCase(), url });
      return fx.respond ? fx.respond(url, i) : new Response("{}");
    }) as typeof fetch,
    smtp: () => mailer,
    pg: () => pool,
  });
  return { ctx, seen };
}

const TABLES = ["connections", "indicators", "metrics", "settings"];
const counts = () => Object.fromEntries(TABLES.map((t) => {
  try { return [t, (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n]; } catch { return [t, -1]; }
}));

/** Renvoie la liste des violations du contrat (vide = conforme). */
export async function checkContract(c: Connector, fx: Fixture): Promise<string[]> {
  const bad: string[] = [];
  // 1. Manifeste valide
  if (!/^[a-z][a-z0-9-]*$/.test(c.id)) bad.push("id invalide");
  for (const k of ["name", "provider", "monogram", "description"] as const) if (!c[k]?.trim()) bad.push(`${k} vide`);
  if (c.monogram.length !== 2) bad.push("le monogramme doit avoir 2 lettres");
  if (!["revenus", "seo", "produit", "alertes", "integre"].includes(c.category)) bad.push("catégorie inconnue");
  if (!(c.minutes >= 0)) bad.push("durée invalide");
  const keys = c.fields.map((f) => f.key);
  if (new Set(keys).size !== keys.length) bad.push("clés de champ en double");
  for (const f of c.fields) {
    if (f.type === "select" && !f.options?.length) bad.push(`champ ${f.key} : select sans options`);
    if (f.secret && f.type === "select") bad.push(`champ ${f.key} : un select ne peut pas être secret`);
  }
  const ids = (c.kpis ?? []).map((k) => k.id);
  if (new Set(ids).size !== ids.length) bad.push("KPI en double");
  if (c.kpis?.length && !c.collect) bad.push("KPI déclarés sans collect()");
  for (const p of c.presets ?? []) if (!ids.includes(p.kpi)) bad.push(`preset ${p.label} : KPI ${p.kpi} inconnu`);
  for (const r of c.readPosts ?? []) if (!/^(POST|PUT) https:\/\//.test(r)) bad.push(`readPosts mal formé : ${r}`);
  if (c.builtin || bad.length) return bad; // carte intégrée : rien à tester ; manifeste invalide : inutile de l'exécuter

  const secrets = secretValues(fx.cfg.secrets).filter((s) => s.length >= 4);
  const hint = c.hint(fx.cfg);
  if (typeof hint !== "string" || !hint) bad.push("hint vide");
  for (const s of secrets) if (hint.includes(s)) bad.push("le hint contient un secret entier");

  // 2. test() puis collect() sous surveillance
  const before = counts();
  const logs: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(orig) as (keyof typeof orig)[]) console[k] = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  const runs: { what: string; seen: Seen; out: unknown }[] = [];
  try {
    const t = recordingCtx(fx);
    const res = await c.test(fx.cfg, t.ctx).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
    runs.push({ what: "test()", seen: t.seen, out: res });
    if (fx.expectOk !== false && !(res as any).ok) bad.push(`test() devrait réussir avec la fixture : ${(res as any).error ?? "échec"}`);
    for (const k of (c.kpis ?? []) as Kpi[]) {
      const r = recordingCtx(fx);
      const params = fx.params?.[k.id] ?? {};
      const v = await c.collect!(fx.cfg, k, params, k.mode === "daily" ? "2026-11-09" : undefined, r.ctx).catch((e) => { bad.push(`collect(${k.id}) a échoué : ${String(e?.message ?? e)}`); return NaN; });
      if (!Number.isNaN(v) && !Number.isFinite(v)) bad.push(`collect(${k.id}) ne renvoie pas un nombre`);
      runs.push({ what: `collect(${k.id})`, seen: r.seen, out: v });
    }
  } finally { Object.assign(console, orig); }

  // 3. Lecture seule chez le fournisseur
  const posts = c.readPosts ?? [];
  const sideFx = new Set(c.sideEffects ?? []);
  for (const { what, seen } of runs) {
    for (const h of seen.http) {
      if (h.method === "GET" || h.method === "HEAD") continue;
      const declared = posts.some((p) => { const [m, ...u] = p.split(" "); return m === h.method && h.url.startsWith(u.join(" ")); });
      if (!declared && !(sideFx.has("notify") && h.method === "POST")) bad.push(`${what} : requête ${h.method} non déclarée (${h.url.split("?")[0]})`);
    }
    if (seen.mails && !sideFx.has("mail")) bad.push(`${what} : envoi d'e-mail non déclaré`);
  }

  // 4. Aucun secret dans les journaux, ni dans les résultats de test()
  const out = JSON.stringify(runs.find((r) => r.what === "test()")?.out ?? {});
  for (const s of secrets) {
    if (logs.some((l) => l.includes(s))) bad.push("un secret apparaît dans les journaux");
    if (out.includes(s)) bad.push("un secret apparaît dans le résultat de test()");
  }

  // 5. Aucune écriture en base
  const after = counts();
  for (const t of TABLES) if (before[t] !== after[t]) bad.push(`test()/collect() ont écrit dans ${t}`);
  return bad;
}
