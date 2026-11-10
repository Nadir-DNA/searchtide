import { readFileSync } from "node:fs";
import { db, type Site } from "./db.ts";
import { connections, createConnection, getSecrets } from "./connections.ts";
import "./modules/state.ts";
import { SC_SCOPE, googleAccessToken, parseServiceAccount, type ServiceAccount } from "./connectors/google.ts";
import { currentCtx } from "./connectors/use.ts";

/** Compte de service à utiliser : la connexion Google (Modules). La variable GOOGLE_SERVICE_ACCOUNT_JSON n'est plus lue, voir convertGoogleEnv(). */
export function serviceAccount(): ServiceAccount | null {
  const conn = connections("google")[0];
  if (!conn) return null;
  try { return parseServiceAccount(String(getSecrets(conn).json)); } catch { return null; }
}

export const gscConfigured = () => connections("google").length > 0;

/** Au démarrage : l'ancienne variable GOOGLE_SERVICE_ACCOUNT_JSON (contenu ou chemin) devient une connexion Google, une seule fois. */
export function convertGoogleEnv(): "converti" | "absent" | "deja-connecte" {
  if (connections("google").length) return "deja-connecte";
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) return "absent";
  const json = raw.startsWith("{") ? raw : readFileSync(raw, "utf8");
  const sa = parseServiceAccount(json);
  // PLAY_BUCKET suit, sinon les indicateurs Play de l'ancien mode perdraient leur bucket
  const playBucket = process.env.PLAY_BUCKET?.trim();
  createConnection({ kind: "google", label: sa.client_email, account: sa.client_email, config: { hint: sa.client_email, ...(playBucket ? { playBucket } : {}) }, secrets: { json }, fingerprintOf: json });
  console.log("[google] GOOGLE_SERVICE_ACCOUNT_JSON converti en connexion ; la variable n'est plus lue.");
  return "converti";
}

/** Propriété Search Console d'un site : réglage Google du projet (ou d'un projet qui contient le site), sinon la colonne du site. */
export function gscPropertyFor(domain: string, projectId?: string): string | null {
  const rows = db.prepare(`SELECT pm.project_id, pm.settings FROM project_modules pm JOIN projects p ON p.id = pm.project_id
    WHERE pm.module_id = 'google' AND pm.enabled = 1 AND EXISTS (SELECT 1 FROM json_each(p.sites) WHERE value = ?)`).all(domain) as { project_id: string; settings: string }[];
  const pick = (r?: { settings: string }) => r ? (JSON.parse(r.settings).gsc_property?.[domain] as string | undefined) : undefined;
  const own = projectId ? pick(rows.find((r) => r.project_id === projectId)) : undefined;
  const any = rows.map(pick).find(Boolean);
  const site = db.prepare("SELECT gsc_property FROM sites WHERE domain = ?").get(domain) as { gsc_property: string | null } | undefined;
  return own ?? any ?? site?.gsc_property ?? null;
}

/** Jeton OAuth du compte de service pour une portée donnée. */
export async function googleToken(scope = SC_SCOPE): Promise<string> {
  const sa = serviceAccount();
  if (!sa) throw new Error("Google n'est pas connecté : ajoutez Google dans Connexions");
  return googleAccessToken(sa, scope, currentCtx());
}
const accessToken = () => googleToken();

async function gscFetch(path: string, body?: object) {
  const res = await currentCtx().fetch(`https://searchconsole.googleapis.com/webmasters/v3/${path}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json() as any;
  if (!res.ok) throw new Error(`Search Console ${res.status} : ${data.error?.message ?? "erreur"}`);
  return data;
}

/** Propriétés Search Console auxquelles le compte de service a accès. */
export async function listProperties(): Promise<string[]> {
  const data = await gscFetch("sites");
  return (data.siteEntry ?? []).map((s: { siteUrl: string }) => s.siteUrl);
}

const upsert = db.prepare(`INSERT INTO gsc_rows (site_id, day, query, page, clicks, impressions, position)
  VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET
  clicks = excluded.clicks, impressions = excluded.impressions, position = excluded.position`);
const saveSync = db.prepare(`INSERT INTO gsc_syncs (site_id, synced_at, last_day, error) VALUES (?, ?, ?, ?)
  ON CONFLICT DO UPDATE SET synced_at = excluded.synced_at, last_day = COALESCE(excluded.last_day, last_day), error = excluded.error`);

/** Importe les données d'un site. Par défaut les 7 derniers jours ; au premier import, 16 mois. */
export async function syncSite(site: Site, days?: number): Promise<{ rows: number }> {
  const property = gscPropertyFor(site.domain);
  if (!property) throw new Error("Aucune propriété Search Console pour ce site");
  const last = db.prepare("SELECT last_day FROM gsc_syncs WHERE site_id = ?").get(site.id) as { last_day: string | null } | undefined;
  const span = days ?? (last?.last_day ? 7 : 486);
  const end = new Date(Date.now() - 86400000);
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const startDate = day(new Date(end.getTime() - (span - 1) * 86400000));
  const endDate = day(end);
  const prop = encodeURIComponent(property);
  let rows = 0, maxDay: string | null = null;
  // Google masque les requêtes rares : sans mot-clé, les totaux par jour et par page restent complets.
  // Trois couches : (query='', page='') = totaux du jour, (query='', page) = par page, (query, page) = détail.
  const layers: [string[], (k: string[]) => [string, string, string]][] = [
    [["date"], (k) => [k[0], "", ""]],
    [["date", "page"], (k) => [k[0], "", k[1]]],
    [["date", "query", "page"], (k) => [k[0], k[1], k[2]]],
  ];
  try {
    for (const [dimensions, keys] of layers) {
      // Pagination : 25 000 lignes maximum par requête
      for (let startRow = 0; ; startRow += 25000) {
        const data = await gscFetch(`sites/${prop}/searchAnalytics/query`, {
          startDate, endDate, dimensions, rowLimit: 25000, startRow, dataState: "all",
        });
        const batch = (data.rows ?? []) as { keys: string[]; clicks: number; impressions: number; position: number }[];
        db.exec("BEGIN");
        for (const r of batch) {
          if (!r.impressions) continue;
          upsert.run(site.id, ...keys(r.keys), r.clicks, r.impressions, r.position);
          if (!maxDay || r.keys[0] > maxDay) maxDay = r.keys[0];
        }
        db.exec("COMMIT");
        rows += batch.length;
        if (batch.length < 25000) break;
      }
    }
    saveSync.run(site.id, Date.now(), maxDay, null);
    return { rows };
  } catch (e) {
    if (db.isTransaction) db.exec("ROLLBACK");
    const msg = `Échec de l'import Google : ${(e as Error).message}`;
    saveSync.run(site.id, Date.now(), null, msg);
    throw new Error(msg);
  }
}

/** Synchronise tous les sites reliés à Search Console (appelé chaque jour). */
export async function syncAll() {
  if (!gscConfigured()) return;
  const sites = (db.prepare("SELECT * FROM sites").all() as Site[]).filter((s) => gscPropertyFor(s.domain));
  for (const s of sites) await syncSite(s).catch((e) => console.error(`[gsc] ${s.domain} :`, e.message));
}
