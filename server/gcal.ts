// Google Agenda côté instance : l'instance parle directement à Google avec un jeton d'accès de courte durée obtenu par le relais
// (le relais détient le secret de l'application, jamais les événements). Occupations, création et suppression de rendez-vous, lien Meet.
import { ConnectorError } from "./connectors/types.ts";

export type GCfg = { config: Record<string, any>; secrets: Record<string, any> };
type Fetch = typeof fetch;
const live: Fetch = (u, i) => fetch(u, { ...i, signal: AbortSignal.timeout(10_000) });
// GCAL_API_BASE : uniquement pour les tests (faux Google local)
const API = process.env.GCAL_API_BASE ?? "https://www.googleapis.com/calendar/v3";
const cache = new Map<string, { token: string; exp: number }>();

/** Jeton d'accès (mis en mémoire jusqu'à une minute avant son expiration). 401 du relais = accès retiré chez Google. */
export async function accessToken(g: GCfg, f: Fetch = live): Promise<string> {
  const refresh = String(g.secrets.refresh_token ?? ""), relay = String(g.config.relay_url ?? "").replace(/\/$/, "");
  if (!refresh || !relay) throw new ConnectorError("format", "Connexion Google incomplète : reconnectez Google Agenda.");
  const hit = cache.get(refresh);
  if (hit && hit.exp > Date.now() + 60_000) return hit.token;
  const r = await f(`${relay}/v1/google/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refresh_token: refresh }) });
  if (r.status === 401) throw new ConnectorError("auth", "L'accès à Google Agenda a été retiré : reconnectez-le.");
  const j = await r.json().catch(() => ({})) as any;
  if (!r.ok || !j.access_token) throw new ConnectorError("other", "Le service Searchtide Connect ne répond pas. Réessayez dans un instant.");
  if (cache.size > 20) cache.clear();
  cache.set(refresh, { token: j.access_token, exp: Date.now() + Number(j.expires_in ?? 3600) * 1000 });
  return j.access_token;
}

async function api(g: GCfg, f: Fetch, method: string, path: string, body?: unknown) {
  const res = await f(`${API}${path}`, { method, headers: { Authorization: `Bearer ${await accessToken(g, f)}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 401 || res.status === 403) {
    const j = await res.clone().json().catch(() => ({})) as any;
    if (res.status === 401 || /insufficient|scope|accessNotConfigured/i.test(JSON.stringify(j))) { cache.clear(); throw new ConnectorError("permission", "Google refuse l'accès à l'agenda : reconnectez Google Agenda en acceptant les deux autorisations."); }
  }
  return res;
}
const cal = (g: GCfg) => encodeURIComponent(String(g.config.calendar_id || "primary"));
/** Identifiant d'événement Google : lettres a-v et chiffres seulement. */
export const eventId = (bookingId: string) => bookingId.replace(/-/g, "");

/** Nom (adresse) du calendrier principal. `events.list` suffit avec la permission « événements » : calendars.get exigerait une autre autorisation. */
export async function whoami(g: GCfg, f: Fetch = live): Promise<{ name: string; tz: string }> {
  const r = await api(g, f, "GET", `/calendars/${cal(g)}/events?maxResults=1&fields=summary,timeZone`);
  if (!r.ok) throw new ConnectorError("other", `Google répond ${r.status}.`);
  const j = await r.json() as any;
  return { name: String(j.summary ?? "Google Agenda"), tz: String(j.timeZone ?? "") };
}

/** Plages occupées [début, fin] en ms UTC, par tranches de 60 jours (limite de période de l'API). */
export async function busyTimes(g: GCfg, fromTs: number, toTs: number, f: Fetch = live): Promise<[number, number][]> {
  const out: [number, number][] = [], id = String(g.config.calendar_id || "primary");
  for (let a = fromTs; a < toTs; a += 60 * 864e5) {
    const b = Math.min(toTs, a + 60 * 864e5);
    const r = await api(g, f, "POST", "/freeBusy", { timeMin: new Date(a).toISOString(), timeMax: new Date(b).toISOString(), items: [{ id }] });
    if (!r.ok) throw new ConnectorError("other", `Google répond ${r.status}.`);
    const c = ((await r.json()) as any).calendars?.[id];
    if (c?.errors?.length) throw new ConnectorError("other", `Google : ${c.errors[0].reason}`);
    for (const x of c?.busy ?? []) out.push([Date.parse(x.start), Date.parse(x.end)]);
  }
  return out;
}

export type EventInput = { id: string; summary: string; description: string; location: string; start: number; end: number; tz: string; meet: boolean };
/** Crée l'événement (identifiant fixe : rejouer l'appel ne crée pas de doublon). Renvoie le lien Meet si demandé. */
export async function putEvent(g: GCfg, e: EventInput, f: Fetch = live): Promise<string | undefined> {
  const body = { id: eventId(e.id), summary: e.summary, description: e.description, ...(e.location ? { location: e.location } : {}),
    start: { dateTime: new Date(e.start).toISOString(), timeZone: e.tz }, end: { dateTime: new Date(e.end).toISOString(), timeZone: e.tz },
    ...(e.meet ? { conferenceData: { createRequest: { requestId: e.id, conferenceSolutionKey: { type: "hangoutsMeet" } } } } : {}) };
  const r = await api(g, f, "POST", `/calendars/${cal(g)}/events?conferenceDataVersion=${e.meet ? 1 : 0}&sendUpdates=none`, body);
  if (r.status !== 409 && !r.ok) throw new ConnectorError("other", `Google refuse l'événement (${r.status}).`);
  if (!e.meet) return undefined;
  // Le lien est en général rendu tout de suite ; sinon (création en cours) on relit une fois.
  for (let i = 0; i < 2; i++) {
    const j = (r.status === 409 || i > 0 ? await (await api(g, f, "GET", `/calendars/${cal(g)}/events/${eventId(e.id)}?conferenceDataVersion=1`)).json() : await r.clone().json()) as any;
    if (j.hangoutLink) return String(j.hangoutLink);
    await new Promise((res) => setTimeout(res, 1500));
  }
  return undefined;
}

export async function deleteEvent(g: GCfg, bookingId: string, f: Fetch = live) {
  const r = await api(g, f, "DELETE", `/calendars/${cal(g)}/events/${eventId(bookingId)}?sendUpdates=none`);
  if (!r.ok && r.status !== 404 && r.status !== 410) throw new ConnectorError("other", `Google refuse la suppression (${r.status}).`);
}
