export class AuthError extends Error {}

// Un seul événement d'expiration par session : dix appels en parallèle ne doivent pas déclencher dix retours.
let authExpiredSent = false;
export function resetAuthExpired() { authExpiredSent = false; }

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: init?.json !== undefined ? { "Content-Type": "application/json" } : init?.headers,
      body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new Error("Impossible de joindre l'instance. Vérifiez qu'elle est démarrée et que l'adresse est correcte.");
  }
  const data = await res.json().catch(() => ({}));
  // 401 : session expirée, ou mot de passe refusé à la connexion (le message du serveur est conservé)
  if (res.status === 401) {
    // Un mot de passe refusé à la connexion garde son message ; une session expirée ramène à la connexion (une fois).
    if (!path.startsWith("/api/login") && !authExpiredSent) { authExpiredSent = true; window.dispatchEvent(new Event("st-auth-expired")); }
    throw new AuthError(data.error ?? "Non authentifié");
  }
  if (!res.ok) throw new Error(data.error ?? `Erreur ${res.status}`);
  return data as T;
}

export type Range = { from: string; to: string };
export type Site = {
  id: string; domain: string; name: string; gsc_property: string | null;
  synced_at: number | null; last_day: string | null; sync_error: string | null; today: number;
};
export type Row = { key: string; visitors: number; pageviews: number };
export type TrafficTotals = { visitors: number; pageviews: number; ai: number };
export type Traffic = {
  range: Range; totals: TrafficTotals; previous: TrafficTotals;
  daily: { day: string; visitors: number; pageviews: number }[];
  pages: Row[]; channels: Row[]; referrers: Row[]; countries: Row[]; devices: Row[]; browsers: Row[];
  campaigns: Row[]; aiReferrers: Row[]; events: { key: string; count: number }[];
};
export type SearchTotals = { clicks: number; impressions: number; ctr: number | null; position: number | null };
export type SearchRow = { clicks: number; impressions: number; ctr?: number; position: number };
export type Search = {
  range: Range; totals: SearchTotals; previous: SearchTotals;
  daily: ({ day: string } & SearchRow)[];
  queries: ({ query: string } & SearchRow)[];
  pages: ({ page: string } & SearchRow)[];
  opportunities: ({ query: string } & SearchRow)[];
};
export type Overview = { range: Range; daily: { day: string; visitors: number }[]; sites: OverviewSite[] };
export type OverviewSite = {
  id: string; domain: string; name: string; gsc_property: string | null; today: number;
  traffic: TrafficTotals; trafficPrev: TrafficTotals; search: SearchTotals | null;
};
