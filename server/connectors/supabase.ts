// Connecteur Supabase : rôle Postgres restreint + fonctions d'agrégat (pas de Management API).
import { ConnectorError, type Cfg, type Connector, type Ctx, type TestResult } from "./types.ts";
import { register } from "./registry.ts";
import { pgQuery } from "./postgres.ts";

const FUNCTIONS = ["users_total()", "signups_on(date)", "signed_in_last(int)", "db_size_bytes()"] as const;

function urlOf(raw: string) {
  let u: URL;
  try { u = new URL(raw); } catch { throw new ConnectorError("format", "L'URL doit ressembler à postgres://searchtide_ro.<référence>:…@…pooler.supabase.com:5432/postgres."); }
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new ConnectorError("format", "L'URL doit commencer par postgres://.");
  if (!u.hostname || !u.username) throw new ConnectorError("format", "L'URL doit contenir l'hôte et l'utilisateur.");
  if (u.port === "6543") throw new ConnectorError("format", "Utilisez le port 5432 (Session pooler) : le mode transaction n'est pas pris en charge.");
  return u;
}
function refOf(u: URL) {
  const user = decodeURIComponent(u.username);
  if (user.includes(".")) return user.split(".").pop()!;
  const m = /^db\.([a-z0-9]+)\.supabase\.co$/i.exec(u.hostname);
  return m?.[1] ?? u.hostname.split(".")[0] ?? "projet";
}
const majorOf = (v: unknown) => /PostgreSQL (\d+)/.exec(String(v ?? ""))?.[1] ?? "?";
const missing = (e: any) => {
  const code = String(e?.code ?? ""), msg = String(e?.message ?? e);
  return code === "42883" || code === "42P01" || /does not exist|n'existe pas/i.test(msg);
};

export const supabase: Connector = {
  id: "supabase", name: "Supabase", provider: "Supabase", monogram: "SB", category: "produit", minutes: 10,
  description: "Comptes créés, connectés récemment et taille de la base, via un rôle en lecture seule et quatre fonctions d'agrégat.",
  unlocks: ["Utilisateurs (total)", "Inscriptions par jour", "Connectés sur 7 / 30 jours", "Taille de la base"],
  fields: [{ key: "url", label: "Adresse de connexion (Session pooler)", type: "text", secret: true, required: true, placeholder: "postgres://searchtide_ro.<référence>:…@…pooler.supabase.com:5432/postgres", help: "Bouton Connect → Session pooler dans Supabase. L'utilisateur est searchtide_ro.<référence>." }],
  guide: [
    { text: "Exécutez le bloc SQL du guide Supabase (rôle searchtide_ro + 4 fonctions) dans l'éditeur SQL du tableau de bord.", url: "/docs/guides/supabase" },
    { text: "Bouton Connect → Session pooler : copiez l'adresse et remplacez le mot de passe par celui du rôle." },
    { text: "Collez l'adresse ici : le port 5432 est requis, l'adresse directe db.….supabase.co n'est pas recommandée (IPv6)." },
  ],
  hint(c: Cfg) { try { const u = urlOf(String(c.secrets.url ?? "")); return `searchtide_ro@${refOf(u)}`; } catch { return "searchtide_ro@projet"; } },
  async test(c: Cfg, ctx: Ctx): Promise<TestResult> {
    const url = String(c.secrets.url ?? ""); const u = urlOf(url);
    const ref = refOf(u), warnings: string[] = [];
    if (/^db\..*\.supabase\.co$/i.test(u.hostname)) warnings.push("Cette adresse directe n'accepte que IPv6 sans option payante : préférez le Session pooler (bouton Connect).");
    const pool = ctx.pg(url); let client;
    try {
      client = await pool.connect();
      await client.query("BEGIN READ ONLY", []);
      await client.query("SET LOCAL statement_timeout = '10s'", []);
      const who = (await client.query("SELECT current_user AS u, current_database() AS d, version() AS v, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su", [])).rows[0] ?? {};
      if (who.su === true) throw new ConnectorError("format", "Compte trop puissant refusé : utilisez le rôle searchtide_ro du guide.");
      let available = 0;
      for (const sql of ["select searchtide.users_total()", "select searchtide.signups_on(current_date)", "select searchtide.signed_in_last(7)", "select searchtide.db_size_bytes()"]) {
        try { await client.query(sql, []); available++; } catch (e) { if (missing(e)) throw new ConnectorError("format", "Les fonctions Searchtide manquent : exécutez le bloc SQL du guide, puis testez à nouveau."); throw e; }
      }
      await client.query("ROLLBACK", []);
      return { ok: true, label: `projet ${ref}`, detail: `projet ${ref}, PostgreSQL ${majorOf(who.v)}, ${available} indicateurs disponibles.`, warnings };
    } catch (e) {
      try { await client?.query("ROLLBACK", []); } catch { /* fermée */ }
      if (e instanceof ConnectorError) throw e;
      const code = String((e as any)?.code ?? "");
      if (code === "28P01" || code === "28000") throw new ConnectorError("auth", `Supabase refuse ces identifiants : le rôle est searchtide_ro.${ref} et le mot de passe celui du bloc SQL.`);
      if (/pause|paused/i.test(String((e as any)?.message ?? ""))) throw new ConnectorError("other", "Le projet semble en pause : réactivez-le dans Supabase, puis testez à nouveau.");
      throw new ConnectorError("other", String((e as Error)?.message ?? e).slice(0, 200));
    } finally { client?.release(); await pool.end().catch(() => {}); }
  },
  kpis: [
    { id: "users_total", label: "Utilisateurs (total)", mode: "total" },
    { id: "signups_on", label: "Inscriptions par jour", mode: "daily", backfill: true },
    { id: "signed_in", label: "Connectés récemment", mode: "total", params: [{ key: "days", label: "Fenêtre (jours)", type: "number", default: "7" }] },
    { id: "db_size_bytes", label: "Taille de la base", mode: "total" },
  ],
  presets: [
    { kpi: "users_total", label: "Utilisateurs (total)" },
    { kpi: "signups_on", label: "Inscriptions par jour" },
    { kpi: "signed_in", label: "Connectés sur 7 jours", params: { days: "7" } },
    { kpi: "signed_in", label: "Connectés sur 30 jours", params: { days: "30" } },
    { kpi: "db_size_bytes", label: "Taille de la base" },
  ],
  toIndicator: (kpi) => ({ source: "supabase", config: { metric: kpi.id } }),
  async collect(c, kpi, params, day, ctx) {
    const url = String(c.secrets.url ?? "");
    const days = Number(params?.days ?? c.config.days ?? 7);
    const sql = kpi.id === "users_total" ? "select searchtide.users_total()"
      : kpi.id === "signups_on" ? "select searchtide.signups_on($1::date)"
      : kpi.id === "signed_in" ? `select searchtide.signed_in_last(${Number.isFinite(days) ? Math.max(1, Math.min(365, Math.trunc(days))) : 7})`
      : kpi.id === "db_size_bytes" ? "select searchtide.db_size_bytes()"
      : "";
    if (!sql) throw new Error(`Mesure Supabase inconnue : ${kpi.id}`);
    try { return await pgQuery(url, sql, day, ctx); }
    catch (e) {
      if (e instanceof ConnectorError && e.kind === "auth") throw new ConnectorError("auth", "Supabase refuse ces identifiants : reconnectez le compte.");
      if (missing(e)) throw new ConnectorError("format", "Les fonctions Searchtide manquent : exécutez le bloc SQL du guide, puis testez à nouveau.");
      throw e;
    }
  },
};
register(supabase);
