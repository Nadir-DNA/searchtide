// Connecteur CalDAV : agenda de l'hôte pour le module Rendez-vous (iCloud, Nextcloud, Fastmail, Synology, Radicale…).
// Lit les plages occupées pour ne proposer que des créneaux libres, écrit chaque RDV réservé et le supprime à l'annulation.
// Google Agenda et Outlook n'acceptent pas CalDAV avec un mot de passe (OAuth obligatoire) : ils passent par l'invitation .ics et le flux iCal.
import { register } from "./registry.ts";
import { ConnectorError, type Cfg, type Connector, type TestResult } from "./types.ts";
import { zonedTs } from "../tz.ts";

export type DavCfg = Pick<Cfg, "config" | "secrets">;
type Fetch = typeof fetch;

const NS = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"';
const xmlOf = (body: string) => `<?xml version="1.0" encoding="utf-8"?>${body}`;
const authOf = (c: DavCfg) => "Basic " + Buffer.from(`${c.config.user ?? ""}:${c.secrets.pass ?? ""}`).toString("base64");

/** Requête WebDAV avec suites de redirections à la main (iCloud renvoie vers un autre serveur ; fetch retirerait l'identification). https obligatoire. */
async function dav(c: DavCfg, f: Fetch, method: string, url: string, body?: string, depth = "0", type = "application/xml; charset=utf-8") {
  for (let hop = 0; hop < 5; hop++) {
    if (!/^https:\/\//.test(url)) throw new ConnectorError("format", "L'adresse de l'agenda doit commencer par https:// (le mot de passe ne circule jamais en clair).");
    const res = await f(url, { method, redirect: "manual", headers: { Authorization: authOf(c), Depth: depth, "Content-Type": type }, body });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) { url = new URL(res.headers.get("location")!, url).href; continue; }
    if (res.status === 401 || res.status === 403) throw new ConnectorError("auth", "Identifiant ou mot de passe refusé. Utilisez un mot de passe d'application, pas celui de votre compte.");
    return { res, url, text: await res.text() };
  }
  throw new ConnectorError("other", "Trop de redirections : vérifiez l'adresse du serveur.");
}

// XML lu à la main : les préfixes d'espaces de noms changent d'un serveur à l'autre (d:, D:, aucun).
const first = (xml: string, name: string) => new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`, "i").exec(xml)?.[1];
const responses = (xml: string) => xml.split(/<(?:\w+:)?response\b[^>]*>/i).slice(1);
const hrefIn = (xml: string, name: string) => first(first(xml, name) ?? "", "href")?.trim();
const isCalendar = (xml: string) => /<(?:\w+:)?calendar\s*\/?>/i.test(first(xml, "resourcetype") ?? "");
const decode = (s: string) => s.replace(/&#13;/g, "\r").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

const PROPS = `<d:propfind ${NS}><d:prop><d:resourcetype/><d:displayname/><d:current-user-principal/><c:calendar-home-set/><c:supported-calendar-component-set/></d:prop></d:propfind>`;

/** Trouve l'agenda à utiliser : l'adresse donnée si c'en est un, sinon le premier agenda du compte (ou celui qui porte le nom demandé). */
export async function resolveCalendar(c: DavCfg, f: Fetch): Promise<{ url: string; name: string }> {
  let url = String(c.config.url ?? "").trim();
  try { if (new URL(url).pathname === "/") url = new URL("/.well-known/caldav", url).href; } catch { throw new ConnectorError("format", "Adresse du serveur invalide."); }
  let r = await dav(c, f, "PROPFIND", url, xmlOf(PROPS));
  if (r.res.status === 404 && /well-known/.test(url)) r = await dav(c, f, "PROPFIND", new URL("/", url).href, xmlOf(PROPS));
  if (r.res.status >= 400) throw new ConnectorError("other", `Le serveur répond ${r.res.status} : vérifiez l'adresse.`);
  const here = responses(r.text)[0] ?? "";
  if (isCalendar(here)) return { url: r.url, name: decode(first(here, "displayname") ?? "Agenda") };

  let home = hrefIn(here, "calendar-home-set");
  if (!home) {
    const principal = hrefIn(here, "current-user-principal");
    if (!principal) throw new ConnectorError("other", "Ce serveur n'a pas l'air de proposer CalDAV : vérifiez l'adresse.");
    const p = await dav(c, f, "PROPFIND", new URL(principal, r.url).href, xmlOf(PROPS));
    home = hrefIn(responses(p.text)[0] ?? "", "calendar-home-set");
  }
  if (!home) throw new ConnectorError("other", "Aucun agenda trouvé pour ce compte.");
  const list = await dav(c, f, "PROPFIND", new URL(home, r.url).href, xmlOf(PROPS), "1");
  const want = String(c.config.calendar ?? "").trim().toLowerCase();
  const cals = responses(list.text).filter((x) => isCalendar(x) && (!first(x, "supported-calendar-component-set") || /name="VEVENT"/i.test(x)))
    .map((x) => ({ url: new URL(first(x, "href")!.trim(), list.url).href, name: decode(first(x, "displayname") ?? "Agenda") }));
  const pick = (want && cals.find((x) => x.name.toLowerCase() === want)) || (!want && cals[0]);
  if (!pick) throw new ConnectorError("format", want ? `Agenda « ${c.config.calendar} » introuvable. Disponibles : ${cals.map((x) => x.name).join(", ") || "aucun"}.` : "Aucun agenda d'événements trouvé.");
  return pick;
}

const stamp = (ts: number) => new Date(ts).toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
const calendarOf = async (c: DavCfg, f: Fetch) => String(c.config.calendar_url || "") || (await resolveCalendar(c, f)).url;

/** Plages occupées [début, fin] en ms UTC. Le serveur déploie les événements récurrents (expand) ; les journées entières, les événements « libres » et annulés sont ignorés. */
export async function busyTimes(c: DavCfg, fromTs: number, toTs: number, f: Fetch = (u, i) => fetch(u, { ...i, signal: AbortSignal.timeout(10_000) })): Promise<[number, number][]> {
  const range = `start="${stamp(fromTs)}" end="${stamp(toTs)}"`;
  const body = xmlOf(`<c:calendar-query ${NS}><d:prop><c:calendar-data><c:expand ${range}/></c:calendar-data></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range ${range}/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`);
  const { res, text } = await dav(c, f, "REPORT", await calendarOf(c, f), body, "1");
  if (res.status >= 400) throw new ConnectorError("other", `L'agenda répond ${res.status}.`);
  const out: [number, number][] = [];
  for (const raw of text.matchAll(/<(?:\w+:)?calendar-data\b[^>]*>([\s\S]*?)<\/(?:\w+:)?calendar-data>/gi)) {
    const ical = decode(raw[1]).replace(/<!\[CDATA\[|\]\]>/g, "").replace(/\r?\n[ \t]/g, "");
    for (const ev of ical.split("BEGIN:VEVENT").slice(1)) {
      const line = (n: string) => new RegExp(`^${n}([;:][^\\r\\n]*)`, "mi").exec(ev)?.[1];
      if (/^TRANSP:TRANSPARENT/mi.test(ev) || /^STATUS:CANCELLED/mi.test(ev)) continue;
      const s = icalTime(line("DTSTART")), dur = line("DURATION"), e = icalTime(line("DTEND")) ?? (s != null && dur ? s + icalDuration(dur) : null);
      if (s != null && e != null && e > s) out.push([s, e]);
    }
  }
  return out;
}

/** « ;TZID=Europe/Paris:20261116T090000 », « :20261116T080000Z » → ms UTC. Journée entière (VALUE=DATE) : null. Heure flottante : lue comme UTC. */
function icalTime(prop?: string): number | null {
  const m = prop && /^(.*?):(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(prop.trim());
  if (!m || m[5] === undefined) return null;
  const day = `${m[2]}-${m[3]}-${m[4]}`, hm = `${m[5]}:${m[6]}`, tz = /TZID=([^;:]+)/i.exec(m[1])?.[1];
  if (tz && !m[8]) { try { return zonedTs(day, hm, tz); } catch { /* fuseau inconnu : repli UTC */ } }
  return Date.UTC(+m[2], +m[3] - 1, +m[4], +m[5], +m[6], +(m[7] ?? 0));
}
function icalDuration(d: string): number {
  const m = /P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?/.exec(d.replace(/^:/, ""));
  return m ? (+(m[1] ?? 0) * 7 + +(m[2] ?? 0)) * 864e5 + +(m[3] ?? 0) * 3600e3 + +(m[4] ?? 0) * 60e3 + +(m[5] ?? 0) * 1e3 : 0;
}

const resource = async (c: DavCfg, f: Fetch, uid: string) => `${(await calendarOf(c, f)).replace(/\/?$/, "/")}${encodeURIComponent(uid)}.ics`;
const live: Fetch = (u, i) => fetch(u, { ...i, signal: AbortSignal.timeout(10_000) });

/** Crée ou remplace l'événement (ressource nommée d'après l'UID). */
export async function putEvent(c: DavCfg, uid: string, ical: string, f: Fetch = live) {
  const { res } = await dav(c, f, "PUT", await resource(c, f, uid), ical, "0", "text/calendar; charset=utf-8");
  if (res.status >= 400) throw new ConnectorError("other", `L'agenda refuse l'événement (${res.status}).`);
}
export async function deleteEvent(c: DavCfg, uid: string, f: Fetch = live) {
  const { res } = await dav(c, f, "DELETE", await resource(c, f, uid), undefined, "0");
  if (res.status >= 400 && res.status !== 404) throw new ConnectorError("other", `L'agenda refuse la suppression (${res.status}).`);
}

export const caldav: Connector = {
  id: "caldav", name: "Agenda (CalDAV)", provider: "Votre agenda", monogram: "CA", category: "alertes", minutes: 5, singleton: true,
  description: "Relie votre agenda iCloud, Nextcloud, Fastmail ou Synology au module Rendez-vous : vos événements bloquent les créneaux, et chaque RDV réservé s'y inscrit.",
  unlocks: ["Créneaux libres selon votre vrai agenda", "Rendez-vous écrits dans votre agenda"],
  readPosts: ["PROPFIND https://", "REPORT https://"],
  fields: [
    { key: "url", label: "Adresse du serveur ou de l'agenda", type: "url", required: true, placeholder: "https://caldav.icloud.com", help: "iCloud : https://caldav.icloud.com · Fastmail : https://caldav.fastmail.com · Nextcloud : l'adresse /remote.php/dav de votre serveur, ou le lien privé d'un agenda." },
    { key: "user", label: "Identifiant", type: "text", required: true, placeholder: "vous@icloud.com" },
    { key: "pass", label: "Mot de passe d'application", type: "text", secret: true, required: true, help: "Un mot de passe d'application créé chez votre fournisseur, pas le mot de passe de votre compte." },
    { key: "calendar", label: "Nom de l'agenda", type: "text", placeholder: "Travail", help: "Facultatif : le premier agenda est utilisé par défaut." },
  ],
  guide: [
    { text: "iCloud : créez un mot de passe pour app sur account.apple.com (Connexion et sécurité).", url: "https://account.apple.com" },
    { text: "Nextcloud : Paramètres personnels > Sécurité > Appareils et sessions > créer un mot de passe d'application." },
    { text: "Google Agenda et Outlook n'acceptent pas CalDAV avec un mot de passe : ils reçoivent l'invitation par e-mail et peuvent s'abonner au flux iCal du module Rendez-vous." },
  ],
  hint(c) { let host = String(c.config.url ?? ""); try { host = new URL(host).host; } catch { /* valeur brute */ } return `${c.config.user ?? ""} · ${host}`; },
  async test(c: Cfg, ctx): Promise<TestResult> {
    if (!String(c.config.user ?? "") || !String(c.secrets.pass ?? "")) throw new ConnectorError("format", "Renseignez l'identifiant et le mot de passe d'application.");
    const cal = await resolveCalendar(c, ctx.fetch);
    return { ok: true, label: cal.name, detail: `Agenda « ${cal.name} » trouvé`, settings: { calendar_url: cal.url, calendar_name: cal.name } };
  },
};
register(caldav);
