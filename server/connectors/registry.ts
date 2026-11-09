// Registre des connecteurs + exécution protégée de test() et collect() : délai maximal, erreurs nettoyées des secrets.
import { createTransport } from "nodemailer";
import pg from "pg";
import { scrub, secretValues } from "../vault.ts";
import { ConnectorError, type Cfg, type Connector, type Ctx, type Kpi, type PublicManifest, type TestResult } from "./types.ts";

const connectors = new Map<string, Connector>();

export function register(c: Connector) {
  if (!/^[a-z][a-z0-9-]*$/.test(c.id)) throw new Error(`Identifiant de connecteur invalide : ${c.id}`);
  if (connectors.has(c.id)) throw new Error(`Connecteur déjà enregistré : ${c.id}`);
  connectors.set(c.id, c);
  return c;
}
export const get = (id: string) => connectors.get(id);
export const all = () => [...connectors.values()];
/** Pour les tests uniquement. */
export const unregister = (id: string) => connectors.delete(id);

export function publicManifest(c: Connector): PublicManifest {
  const { test: _t, collect: _c, hint: _h, readPosts: _r, sideEffects: _s, ...rest } = c;
  return { ...rest, hasKpis: !!c.kpis?.length };
}

/** Accès réseau réels. `fetch` est relu à chaque appel pour que les tests puissent le remplacer globalement. */
export function realCtx(over: Partial<Ctx> = {}): Ctx {
  return {
    fetch: (u, i) => globalThis.fetch(u, i),
    now: () => new Date(),
    timeoutMs: 10_000,
    smtp: (o) => createTransport({ ...o, connectionTimeout: 10_000, socketTimeout: 10_000 }) as any,
    pg: (url) => new pg.Pool({ connectionString: url, max: 2, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000,
      ssl: /sslmode=require|supabase/.test(url) ? { rejectUnauthorized: false } : undefined }) as any,
    ...over,
  };
}

const timeoutMessage = (c: Connector) => `${c.provider} ne répond pas. Réessayez dans un instant.`;

/** Ajoute le délai maximal (R5) à chaque requête du connecteur. */
function bounded(ctx: Ctx): Ctx {
  return { ...ctx, fetch: (u, i) => ctx.fetch(u, { ...i, signal: i?.signal ?? AbortSignal.timeout(ctx.timeoutMs) }) };
}

async function withDeadline<T>(c: Connector, ctx: Ctx, run: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new ConnectorError("timeout", timeoutMessage(c))), ctx.timeoutMs); });
  try { return await Promise.race([run(), limit]); } finally { clearTimeout(timer); }
}

function toError(c: Connector, e: unknown, cfg: Cfg): ConnectorError {
  const raw = e instanceof Error ? e : new Error(String(e));
  const name = (raw as any).name;
  if (raw instanceof ConnectorError) return new ConnectorError(raw.kind, scrub(raw.message, secretValues(cfg.secrets)));
  if (name === "TimeoutError" || name === "AbortError" || /timed? ?out|ETIMEDOUT/i.test(raw.message)) return new ConnectorError("timeout", timeoutMessage(c));
  return new ConnectorError("other", scrub(raw.message, secretValues(cfg.secrets)).slice(0, 300));
}

/**
 * Teste une connexion. Ne lève jamais : un échec renvoie `{ ok: false, error, failure }` dont le texte ne contient
 * aucun secret (R4). Le délai maximal est celui du contexte (10 s par défaut).
 */
export async function runTest(c: Connector, cfg: Cfg, ctx: Ctx = realCtx()): Promise<TestResult> {
  const b = bounded(ctx);
  try {
    const r = await withDeadline(c, ctx, () => c.test(cfg, b));
    if (r.error) r.error = scrub(r.error, secretValues(cfg.secrets));
    if (r.warnings) r.warnings = r.warnings.map((w) => scrub(w, secretValues(cfg.secrets)));
    return r;
  } catch (e) {
    const err = toError(c, e, cfg);
    return { ok: false, error: err.message, failure: err.kind };
  }
}

/** Relève un KPI. Les erreurs sont nettoyées des secrets de la connexion ; elles sont relancées pour que l'appelant les enregistre. */
export async function runCollect(c: Connector, cfg: Cfg, kpi: Kpi | string, params: Record<string, any>, day: string | undefined, ctx: Ctx = realCtx()): Promise<number> {
  const def = typeof kpi === "string" ? c.kpis?.find((k) => k.id === kpi) : kpi;
  if (!def || !c.collect) throw new Error(`${c.name} ne fournit pas l'indicateur « ${typeof kpi === "string" ? kpi : kpi.id} »`);
  try {
    const v = await withDeadline(c, { ...ctx, timeoutMs: Math.max(ctx.timeoutMs, 120_000) }, () => c.collect!(cfg, def, params, day, bounded({ ...ctx, timeoutMs: Math.max(ctx.timeoutMs, 120_000) })));
    if (!Number.isFinite(v)) throw new ConnectorError("format", `${c.provider} n'a pas renvoyé de nombre`);
    return v;
  } catch (e) { throw toError(c, e, cfg); }
}
