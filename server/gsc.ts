import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { db, type Site } from "./db.ts";

type ServiceAccount = { client_email: string; private_key: string };

function serviceAccount(): ServiceAccount | null {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  // Accepte le JSON directement ou le chemin du fichier téléchargé depuis Google Cloud
  return JSON.parse(raw.trim().startsWith("{") ? raw : readFileSync(raw, "utf8"));
}

export const gscConfigured = () => !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

let cached: { token: string; exp: number } | null = null;

/** Jeton OAuth du compte de service (JWT signé RS256, sans dépendance Google). */
async function accessToken(): Promise<string> {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const sa = serviceAccount();
  if (!sa) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON n'est pas configuré");
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iss: sa.client_email, scope: "https://www.googleapis.com/auth/webmasters.readonly",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  })}`;
  const jwt = `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(sa.private_key, "base64url")}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  const data = await res.json() as { access_token?: string; expires_in?: number; error_description?: string };
  if (!data.access_token) throw new Error(`Google OAuth : ${data.error_description ?? res.status}`);
  cached = { token: data.access_token, exp: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return cached.token;
}

async function gscFetch(path: string, body?: object) {
  const res = await fetch(`https://searchconsole.googleapis.com/webmasters/v3/${path}`, {
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
  if (!site.gsc_property) throw new Error("Aucune propriété Search Console pour ce site");
  const last = db.prepare("SELECT last_day FROM gsc_syncs WHERE site_id = ?").get(site.id) as { last_day: string | null } | undefined;
  const span = days ?? (last?.last_day ? 7 : 486);
  const end = new Date(Date.now() - 86400000);
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const startDate = day(new Date(end.getTime() - (span - 1) * 86400000));
  const endDate = day(end);
  const prop = encodeURIComponent(site.gsc_property);
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
  const sites = db.prepare("SELECT * FROM sites WHERE gsc_property IS NOT NULL").all() as Site[];
  for (const s of sites) await syncSite(s).catch((e) => console.error(`[gsc] ${s.domain} :`, e.message));
}
