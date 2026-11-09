// Connecteur Postgres en lecture seule (D2, R7) : la lecture seule est IMPOSÉE par le serveur, pas laissée à la confiance.
//  1. une seule instruction SELECT ou WITH : tout « ; » hors chaîne, commentaire ou identifiant entre guillemets est refusé ;
//  2. chaque requête s'exécute dans BEGIN READ ONLY + SET LOCAL statement_timeout = '10s', puis ROLLBACK ;
//  3. les deux premières couches sont indépendantes : même si le garde-fou syntaxique était contourné, le serveur refuse toute écriture
//     dans la transaction en lecture seule (vérifié contre un vrai Postgres) ;
//  4. un compte superutilisateur est refusé au test ; un compte qui peut écrire est signalé.
import { register } from "./registry.ts";
import { ConnectorError, type Cfg, type Connector, type Ctx, type TestResult } from "./types.ts";

const FORBIDDEN = "Une seule requête SELECT est acceptée, sans point-virgule.";

/** Positions des « ; » qui séparent des instructions (hors chaînes, identifiants, dollar-quoting et commentaires). */
export function statementSeparators(sql: string): number[] {
  const out: number[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i], d = sql[i + 1];
    if (c === "-" && d === "-") { const e = sql.indexOf("\n", i); i = e < 0 ? n : e + 1; continue; }
    if (c === "/" && d === "*") { // commentaires imbriqués possibles
      let depth = 1; i += 2;
      while (i < n && depth) { if (sql[i] === "/" && sql[i + 1] === "*") { depth++; i += 2; } else if (sql[i] === "*" && sql[i + 1] === "/") { depth--; i += 2; } else i++; }
      continue;
    }
    if (c === "'" || c === '"') {
      const escape = c === "'" && i > 0 && /[eE]/.test(sql[i - 1]) && !/[A-Za-z0-9_]/.test(sql[i - 2] ?? " "); // E'…\'…'
      i++;
      while (i < n) {
        if (escape && sql[i] === "\\") { i += 2; continue; }
        if (sql[i] === c) { if (sql[i + 1] === c) { i += 2; continue; } break; }
        i++;
      }
      i++; continue;
    }
    if (c === "$") {
      const m = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.exec(sql.slice(i));
      if (m && !/[A-Za-z0-9_]/.test(sql[i - 1] ?? " ")) { const end = sql.indexOf(m[0], i + m[0].length); i = end < 0 ? n : end + m[0].length; continue; }
    }
    if (c === ";") out.push(i);
    i++;
  }
  return out;
}

/** Refuse tout ce qui n'est pas un unique SELECT/WITH. Lève ConnectorError("format"). */
export function checkSql(sql: string) {
  if (typeof sql !== "string" || !sql.trim()) throw new ConnectorError("format", "La requête est vide.");
  if (statementSeparators(sql).length) throw new ConnectorError("format", FORBIDDEN);
  // premier mot, après espaces, parenthèses et commentaires
  const head = sql.replace(/^(\s|--[^\n]*\n?|\/\*[\s\S]*?\*\/|\()+/, "");
  if (!/^(select|with|values|table)\b/i.test(head)) throw new ConnectorError("format", "Seules les requêtes SELECT sont acceptées.");
}

/** Exécute une requête de lecture et renvoie un nombre. Toujours en lecture seule, 10 s au plus. */
export async function pgQuery(url: string, sql: string, day: string | undefined, ctx: Ctx): Promise<number> {
  checkSql(sql);
  const pool = ctx.pg(url);
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN READ ONLY", []);
    await client.query("SET LOCAL statement_timeout = '10s'", []);
    const res = await client.query(sql, sql.includes("$1") ? [day] : []);
    await client.query("ROLLBACK", []);
    const v = Number(Object.values(res.rows[0] ?? {})[0] ?? 0);
    if (!Number.isFinite(v)) throw new ConnectorError("format", "La requête doit renvoyer un nombre.");
    return v;
  } catch (e) {
    try { await client?.query("ROLLBACK", []); } catch { /* connexion déjà fermée */ }
    throw mapPgError(e, url);
  } finally { client?.release(); await pool.end().catch(() => {}); }
}

function parseUrl(url: string): URL {
  let u: URL;
  try { u = new URL(url); } catch { throw new ConnectorError("format", "L'URL doit ressembler à postgres://utilisateur:motdepasse@hôte:5432/base."); }
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new ConnectorError("format", "L'URL doit commencer par postgres://.");
  if (!u.hostname || !u.username) throw new ConnectorError("format", "L'URL doit contenir l'hôte et l'utilisateur : postgres://utilisateur:motdepasse@hôte:5432/base.");
  return u;
}

function mapPgError(e: any, url: string): ConnectorError {
  if (e instanceof ConnectorError) return e;
  const code = String(e?.code ?? ""), msg = String(e?.message ?? e);
  let host = "la base", port = "";
  try { const u = new URL(url); host = u.hostname; port = u.port || "5432"; } catch { /* URL illisible */ }
  if (code === "28P01" || code === "28000") return new ConnectorError("auth", "PostgreSQL refuse ces identifiants : vérifiez l'utilisateur et le mot de passe.");
  if (code === "57014") return new ConnectorError("timeout", "La requête dépasse 10 secondes et a été interrompue : simplifiez-la ou ajoutez un index.");
  if (code === "25006") return new ConnectorError("format", "Cette requête essaie d'écrire : seules les lectures sont acceptées.");
  if (code === "42501") return new ConnectorError("permission", "Permission manquante : ce compte n'a pas le droit de lire cette table (GRANT SELECT).");
  if (/ETIMEDOUT|timeout/i.test(code + msg)) return new ConnectorError("timeout", "La base de données ne répond pas. Réessayez dans un instant.");
  if (["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ECONNRESET"].includes(code)) return new ConnectorError("other", `Connexion impossible à ${host}:${port} : vérifiez l'hôte et le port.`);
  return new ConnectorError("other", msg.slice(0, 200));
}

export const postgres: Connector = {
  id: "postgres", name: "Postgres (lecture seule)", provider: "La base de données", monogram: "PG", category: "produit", minutes: 10,
  description: "Calcule n'importe quel chiffre de votre base produit avec une requête SELECT : inscriptions, utilisateurs actifs, activation, rétention. Lecture seule imposée.",
  unlocks: ["Tout chiffre calculable en SQL", "Modèles : inscriptions, utilisateurs actifs, activation, rétention"],
  fields: [{ key: "url", label: "URL de connexion", type: "text", secret: true, required: true, placeholder: "postgres://searchtide_ro:motdepasse@hôte:5432/base", help: "Utilisez le compte en lecture seule du guide : un compte superutilisateur est refusé." }],
  guide: [
    { text: "Créez un compte en lecture seule avec ce bloc SQL (remplacez le mot de passe et le nom de la base) :\nCREATE ROLE searchtide_ro LOGIN PASSWORD 'choisissez-un-mot-de-passe';\nGRANT CONNECT ON DATABASE votre_base TO searchtide_ro;\nGRANT USAGE ON SCHEMA public TO searchtide_ro;\nGRANT SELECT ON ALL TABLES IN SCHEMA public TO searchtide_ro;" },
    { text: "Collez l'URL de ce compte (postgres://searchtide_ro:…@hôte:5432/base)." },
    { text: "Testez : la connexion est refusée si le compte est superutilisateur et signalée s'il peut écrire." },
  ],
  hint(c) { try { const u = parseUrl(String(c.secrets.url ?? "")); return `${decodeURIComponent(u.username)}@${u.host}${u.pathname}`; } catch { return "base Postgres"; } },
  async test(c: Cfg, ctx): Promise<TestResult> {
    const url = String(c.secrets.url ?? "");
    parseUrl(url);
    const pool = ctx.pg(url);
    let client;
    try {
      client = await pool.connect();
      await client.query("BEGIN READ ONLY", []);
      await client.query("SET LOCAL statement_timeout = '10s'", []);
      const who = (await client.query("SELECT current_user AS u, current_database() AS d, version() AS v, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su", [])).rows[0] ?? {};
      if (who.su === true) throw new ConnectorError("format", "Compte superutilisateur refusé : créez un compte en lecture seule.");
      const writes = (await client.query(
        "SELECT (has_schema_privilege(current_user, 'public', 'CREATE') OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema') AND has_table_privilege(c.oid, 'INSERT,UPDATE,DELETE'))) AS can_write", [])).rows[0]?.can_write === true;
      await client.query("ROLLBACK", []);
      const major = /PostgreSQL (\d+)/.exec(String(who.v))?.[1] ?? "?";
      return { ok: true, label: String(who.d ?? "base"), detail: `base ${who.d}, PostgreSQL ${major}, compte ${who.u}`, warnings: writes ? ["Ce compte peut écrire : utilisez un compte en lecture seule (modèle dans le guide)."] : [] };
    } catch (e) {
      try { await client?.query("ROLLBACK", []); } catch { /* fermée */ }
      throw mapPgError(e, url);
    } finally { client?.release(); await pool.end().catch(() => {}); }
  },
  kpis: [
    { id: "sql_daily", label: "Requête SQL (un chiffre par jour)", mode: "daily", backfill: true, params: [{ key: "sql", label: "Requête SQL (un seul SELECT ; $1 = le jour)", type: "textarea", required: true }] },
    { id: "sql_total", label: "Requête SQL (un niveau)", mode: "total", params: [{ key: "sql", label: "Requête SQL (un seul SELECT)", type: "textarea", required: true }] },
  ],
  presets: [
    { kpi: "sql_daily", label: "Inscriptions par jour", params: { sql: "SELECT COUNT(*) FROM users WHERE created_at >= $1::date AND created_at < $1::date + 1" } },
    { kpi: "sql_total", label: "Utilisateurs actifs sur 7 jours", params: { sql: "SELECT COUNT(DISTINCT user_id) FROM events WHERE created_at >= now() - interval '7 days'" } },
    { kpi: "sql_total", label: "Utilisateurs activés", params: { sql: "SELECT COUNT(*) FROM users WHERE activated_at IS NOT NULL" } },
    { kpi: "sql_total", label: "Rétention à 7 jours (%)", params: { sql: "SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE last_seen_at >= created_at + interval '7 days') / NULLIF(COUNT(*), 0), 1) FROM users WHERE created_at < now() - interval '7 days'" } },
  ],
  async collect(c, kpi, params, day, ctx) { return pgQuery(String(c.secrets.url ?? ""), String(params.sql ?? ""), kpi.mode === "daily" ? day : undefined, ctx); },
};
register(postgres);
