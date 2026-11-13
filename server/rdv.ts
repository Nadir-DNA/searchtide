// Module Rendez-vous : une page de réservation publique par type de RDV (/rdv/:slug), façon Calendly.
// Le client choisit un créneau, reçoit une invitation .ics ; vous la recevez aussi, et un flux iCal d'abonnement liste tous les RDV.
// Les RDV se rangent par projet. Hôte unique pour l'instant (host_id prévu pour une équipe plus tard).
import type { Hono } from "hono";
import type { McpServer } from "@modelcontextprotocol/server";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { db } from "./db.ts";
import "./projects.ts";
import { migrate } from "./migrations.ts";
import { mailSetup } from "./connectors/channels.ts";
import { clientIp } from "./net.ts";
import { zonedTs } from "./tz.ts";
import { connections, getSecrets } from "./connections.ts";
import * as dav from "./connectors/caldav.ts";
import * as gcal from "./gcal.ts";
import { isEnabled } from "./modules/state.ts";

migrate("2026-11-13-rdv", `
CREATE TABLE booking_types (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, host_id TEXT NOT NULL DEFAULT 'admin',
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  duration_min INTEGER NOT NULL, location_kind TEXT NOT NULL, location_value TEXT NOT NULL DEFAULT '',
  min_notice_h INTEGER NOT NULL DEFAULT 4, buffer_min INTEGER NOT NULL DEFAULT 0, horizon_days INTEGER NOT NULL DEFAULT 60, step_min INTEGER NOT NULL DEFAULT 30,
  tz TEXT NOT NULL DEFAULT 'Europe/Paris', rules TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);
CREATE TABLE booking_blocks (day TEXT PRIMARY KEY, note TEXT NOT NULL DEFAULT '');
CREATE TABLE bookings (
  id TEXT PRIMARY KEY, type_id TEXT NOT NULL REFERENCES booking_types(id) ON DELETE CASCADE,
  start_ts INTEGER NOT NULL, end_ts INTEGER NOT NULL,
  name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '', message TEXT NOT NULL DEFAULT '', client_tz TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed', token TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, cancelled_at INTEGER
);
CREATE INDEX bookings_start ON bookings(start_ts);
`);
migrate("2026-11-13-rdv-meet", "ALTER TABLE bookings ADD COLUMN location_override TEXT");

type Row = Record<string, any>;
const HM = /^([01]\d|2[0-3]):[0-5]\d$/, DAY = /^\d{4}-\d{2}-\d{2}$/;
const RESERVED = new Set(["c", "feed"]);
const KINDS: Record<string, string> = { meet: "Google Meet", teams: "Microsoft Teams", zoom: "Zoom", phone: "Téléphone", other: "Autre" };
const baseUrl = () => process.env.PUBLIC_URL ?? "";
const validTz = (tz: string) => { try { new Intl.DateTimeFormat("fr", { timeZone: tz }); return true; } catch { return false; } };
const WEEK = Object.fromEntries(["1", "2", "3", "4", "5"].map((d) => [d, [["09:00", "12:00"], ["14:00", "18:00"]]]));

// ── Calcul des créneaux ──
export { zonedTs };
const dayIn = (ts: number, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(ts);
const addDays = (day: string, n: number) => new Date(Date.parse(day + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);

/** Créneaux libres (ms UTC) d'un type entre deux instants : horaires de la semaine, jours bloqués, préavis, horizon, RDV existants + tampon. */
export function freeSlots(t: Row, fromTs: number, toTs: number, now = Date.now(), extra: [number, number][] = []): number[] {
  const rules = JSON.parse(t.rules) as Record<string, [string, string][]>;
  const blocked = new Set((db.prepare("SELECT day FROM booking_blocks").all() as Row[]).map((r) => r.day));
  const busy = [...db.prepare("SELECT start_ts, end_ts FROM bookings WHERE status = 'confirmed' AND end_ts > ?").all(now - 864e5) as Row[], ...extra.map(([start_ts, end_ts]) => ({ start_ts, end_ts }))];
  const earliest = Math.max(fromTs, now + t.min_notice_h * 3600e3), latest = Math.min(toTs, now + t.horizon_days * 864e5);
  const dur = t.duration_min * 60e3, buf = t.buffer_min * 60e3, step = t.step_min * 60e3, out: number[] = [];
  const last = dayIn(latest, t.tz);
  for (let day = addDays(dayIn(earliest, t.tz), 0); day <= last; day = addDays(day, 1)) {
    if (blocked.has(day)) continue;
    for (const [a, b] of rules[String(new Date(day + "T00:00:00Z").getUTCDay())] ?? []) {
      const end = zonedTs(day, b, t.tz);
      for (let s = zonedTs(day, a, t.tz); s + dur <= end; s += step)
        if (s >= earliest && s <= latest && !busy.some((x) => s < x.end_ts + buf && s + dur + buf > x.start_ts)) out.push(s);
    }
  }
  return out;
}

// ── Réservation ──
const bookingFields = z.object({
  start: z.number().int(), name: z.string().trim().min(1).max(100), email: z.string().trim().max(200).pipe(z.email()),
  phone: z.string().trim().max(40).default(""), message: z.string().trim().max(2000).default(""),
  tz: z.string().refine(validTz).optional(), reschedule: z.string().max(100).optional(), website: z.string().max(200).optional(),
});
const joined = "SELECT b.*, t.name AS type_name, t.slug, t.location_kind, t.location_value, t.duration_min, t.tz, t.project_id, p.name AS project_name, p.color AS project_color FROM bookings b JOIN booking_types t ON t.id = b.type_id LEFT JOIN projects p ON p.id = t.project_id";
const byId = (id: string) => db.prepare(`${joined} WHERE b.id = ?`).get(id) as Row | undefined;
const byToken = (token: string) => db.prepare(`${joined} WHERE b.token = ?`).get(token) as Row | undefined;

/** Réserve un créneau de façon atomique (transaction immédiate) ; `reschedule` annule l'ancien RDV au même moment. */
export function book(t: Row, input: z.infer<typeof bookingFields>, extra: [number, number][] = []) {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (input.reschedule) {
      const old = byToken(input.reschedule);
      if (!old || old.status !== "confirmed" || old.type_id !== t.id) throw new Error("Rendez-vous à déplacer introuvable");
      db.prepare("UPDATE bookings SET status = 'cancelled', cancelled_at = ? WHERE id = ?").run(Date.now(), old.id);
    }
    if (!freeSlots(t, input.start, input.start, Date.now(), extra).includes(input.start)) throw new Error("Ce créneau n'est plus disponible");
    const n = (db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE type_id = ? AND email = ? AND status = 'confirmed' AND start_ts > ?").get(t.id, input.email.toLowerCase(), Date.now()) as Row).n;
    if (n >= 3) throw new Error("Vous avez déjà 3 rendez-vous à venir pour ce motif");
    const id = randomUUID();
    db.prepare("INSERT INTO bookings (id, type_id, start_ts, end_ts, name, email, phone, message, client_tz, token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, t.id, input.start, input.start + t.duration_min * 60e3, input.name, input.email.toLowerCase(), input.phone, input.message, input.tz ?? null, randomBytes(18).toString("base64url"), Date.now());
    db.exec("COMMIT");
    return byId(id)!;
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}

export function cancel(id: string) {
  const b = byId(id);
  if (!b || b.status !== "confirmed") return null;
  db.prepare("UPDATE bookings SET status = 'cancelled', cancelled_at = ? WHERE id = ?").run(Date.now(), id);
  return byId(id)!;
}

// ── iCalendar ──
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
// shortcut: pliage par caractères (pas par octets), tolérable pour des textes courts ; à revoir si un client d'agenda rejette les accents.
const fold = (l: string) => l.length <= 72 ? l : l.match(/.{1,72}/g)!.join("\r\n ");
const stamp = (ts: number) => new Date(ts).toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
// Lien généré automatiquement (Meet) prioritaire sur le lien saisi dans le type de RDV
const link = (b: Row) => b.location_override || b.location_value;
const where = (b: Row) => link(b) || (b.location_kind === "meet" ? "lien communiqué avant le rendez-vous" : "");
const place = (b: Row) => link(b) || KINDS[b.location_kind] || "";

export function ics(list: Row[], method: "PUBLISH" | "REQUEST" | "CANCEL" | "STORE", host = ""): string {
  // STORE : ressource CalDAV, qui ne doit pas porter de METHOD (RFC 4791 §4.1)
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Searchtide//Rendez-vous//FR", "CALSCALE:GREGORIAN", ...(method === "STORE" ? [] : [`METHOD:${method}`]), "X-WR-CALNAME:Rendez-vous Searchtide"];
  for (const b of list) {
    const cancelled = b.status === "cancelled";
    lines.push("BEGIN:VEVENT", `UID:${b.id}@searchtide`, `DTSTAMP:${stamp(b.cancelled_at ?? b.created_at)}`, `DTSTART:${stamp(b.start_ts)}`, `DTEND:${stamp(b.end_ts)}`,
      `SUMMARY:${esc(`${b.type_name} — ${b.name}`)}`,
      `DESCRIPTION:${esc([`${KINDS[b.location_kind]} : ${where(b)}`, b.phone && `Tél. : ${b.phone}`, `E-mail : ${b.email}`, b.message].filter(Boolean).join("\n"))}`,
      `LOCATION:${esc(place(b))}`, `STATUS:${cancelled ? "CANCELLED" : "CONFIRMED"}`, `SEQUENCE:${cancelled ? 1 : 0}`);
    if (host) lines.push(`ORGANIZER:mailto:${host}`);
    lines.push(`ATTENDEE;CN=${esc(b.name)}:mailto:${b.email}`, "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

const feedToken = () => createHmac("sha256", process.env.SECRET ?? "dev-secret").update("rdv-feed").digest("base64url").slice(0, 32);
export const feedUrl = () => `${baseUrl()}/rdv/feed/${feedToken()}.ics`;
const when = (ts: number, tz: string) => new Intl.DateTimeFormat("fr-FR", { timeZone: tz, dateStyle: "full", timeStyle: "short" }).format(ts);

// ── Courriels ──
type Mailer = { sendMail: (m: Row) => Promise<unknown> };
/** Invitation (ou annulation) au client et à l'hôte. Une panne d'envoi n'annule jamais le RDV : elle est journalisée. */
export async function notify(b: Row, kind: "created" | "cancelled", opts: { transport?: Mailer } = {}) {
  const mail = opts.transport ? null : mailSetup();
  const transport = opts.transport ?? mail?.transport;
  if (!transport) return { sent: false };
  const from = mail?.from || process.env.REPORT_FROM || "rdv@searchtide.local";
  const hostTo = process.env.RDV_NOTIFY_TO || mail?.to || "";
  const manage = `${baseUrl()}/rdv/c/${b.token}`;
  const cancelled = kind === "cancelled", method = cancelled ? "CANCEL" : "REQUEST";
  const msg = (to: string, subject: string, text: string, tz: string) => transport.sendMail({
    from, to, subject, text: text.replaceAll("{quand}", when(b.start_ts, tz)), icalEvent: { method, content: ics([b], method, hostTo || from) },
  });
  try {
    const detail = `${b.type_name}\n${KINDS[b.location_kind]} : ${where(b)}`;
    await msg(b.email, cancelled ? `Rendez-vous annulé : ${b.type_name}` : `Rendez-vous confirmé : ${b.type_name}`,
      cancelled ? `Bonjour ${b.name},\n\nVotre rendez-vous du {quand} est annulé.\n\nReprendre un créneau : ${baseUrl()}/rdv/${b.slug}`
        : `Bonjour ${b.name},\n\nVotre rendez-vous est confirmé : {quand}.\n${detail}\n\nL'invitation est jointe : elle s'ajoute à votre agenda.\nAnnuler ou déplacer : ${manage}`, b.client_tz ?? b.tz);
    if (hostTo) await msg(hostTo, `${cancelled ? "RDV annulé" : "Nouveau RDV"} : ${b.name} — ${b.type_name}`,
      `${cancelled ? "Annulé" : "Réservé"} : {quand}\n${detail}\n\n${b.name} <${b.email}>${b.phone ? `\nTél. : ${b.phone}` : ""}${b.message ? `\n\n${b.message}` : ""}`, b.tz);
    return { sent: true };
  } catch (e) { console.error("[rdv] e-mail non envoyé :", (e as Error).message); return { sent: false, error: (e as Error).message }; }
}


// ── Agenda de l'hôte (facultatif) : Google Agenda ou CalDAV. Lit les occupations, écrit les RDV, crée le lien Meet ──
type Provider = { id: string; kind: "google" | "caldav"; name: string; busy(a: number, b: number): Promise<[number, number][]>; put(b: Row): Promise<string | undefined>; del(id: string): Promise<void> };
const rowToCfg = (c: Row) => ({ config: c.config, secrets: getSecrets(c) });
export function providerOf(): Provider | null {
  try {
    const g = connections("gcal").find((c) => c.status !== "reconnect");
    if (g) {
      const cfg = rowToCfg(g);
      return { id: g.id, kind: "google", name: String(g.config.email ?? g.label), busy: (a, b) => gcal.busyTimes(cfg, a, b), del: (id) => gcal.deleteEvent(cfg, id),
        put: (b) => gcal.putEvent(cfg, { id: b.id, summary: `${b.type_name} — ${b.name}`, start: b.start_ts, end: b.end_ts, tz: b.tz,
          description: [`${KINDS[b.location_kind]} : ${where(b)}`, b.phone && `Tél. : ${b.phone}`, `E-mail : ${b.email}`, b.message].filter(Boolean).join("\n"),
          location: link(b), meet: b.location_kind === "meet" && !b.location_value }) };
    }
    const c = connections("caldav").find((x) => x.status !== "reconnect");
    if (c) {
      const cfg = rowToCfg(c);
      return { id: c.id, kind: "caldav", name: String(c.config.calendar_name ?? c.label), busy: (a, b) => dav.busyTimes(cfg, a, b), del: (id) => dav.deleteEvent(cfg, id),
        put: async (b) => { await dav.putEvent(cfg, b.id, ics([b], "STORE", "")); return undefined; } };
    }
  } catch { /* coffre illisible : comme sans agenda */ }
  return null;
}
const busyCache = new Map<string, { at: number; busy: [number, number][] }>();
/** Plages occupées de l'agenda connecté. Si l'agenda ne répond pas, on n'écarte rien : les RDV ne dépendent jamais de lui. */
export async function externalBusy(fromTs: number, toTs: number): Promise<[number, number][]> {
  const p = providerOf();
  if (!p) return [];
  const a = Math.floor(fromTs / 864e5) * 864e5, b = Math.ceil(toTs / 864e5) * 864e5, key = `${p.id}:${a}:${b}`, hit = busyCache.get(key);
  if (hit && hit.at > Date.now() - 60_000) return hit.busy;
  try {
    const busy = await p.busy(a, b);
    if (busyCache.size > 50) busyCache.clear();
    busyCache.set(key, { at: Date.now(), busy });
    return busy;
  } catch (e) { console.error("[rdv] agenda illisible :", (e as Error).message); return []; }
}
/** Écrit (ou supprime) le RDV dans l'agenda connecté. Même UID que l'invitation : aucun doublon. Renvoie le lien Meet s'il vient d'être créé. */
export async function calendarSync(b: Row, kind: "created" | "cancelled"): Promise<string | undefined> {
  const p = providerOf();
  if (!p) return undefined;
  try {
    busyCache.clear();
    if (kind === "created") return await p.put(b);
    await p.del(b.id);
  } catch (e) { console.error("[rdv] agenda non mis à jour :", (e as Error).message); }
  return undefined;
}
/** Agenda d'abord (il peut fournir le lien Meet), puis e-mails : l'invitation porte le bon lien. */
export const after = async (b: Row, kind: "created" | "cancelled", opts: { transport?: Mailer } = {}) => {
  const meet = await calendarSync(b, kind);
  if (meet) db.prepare("UPDATE bookings SET location_override = ? WHERE id = ?").run(meet, b.id);
  return notify(meet ? byId(b.id) ?? b : b, kind, opts);
};

// ── Pages publiques (rendues côté serveur, sans framework) ──
const h = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const CSS = `:root{--bg:#fff;--ink:#111;--muted:#667;--line:#dde;--card:#f7f7fa}@media(prefers-color-scheme:dark){:root{--bg:#0e0f12;--ink:#eee;--muted:#99a;--line:#2a2c33;--card:#17181c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,sans-serif}main{max-width:640px;margin:0 auto;padding:32px 16px}
h1{font-weight:500;margin:.2em 0}.muted{color:var(--muted)}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;margin-top:20px}
button,.btn{font:inherit;border:1px solid var(--line);background:var(--bg);color:var(--ink);border-radius:10px;padding:8px 14px;cursor:pointer;text-decoration:none;display:inline-block}
button.on,.primary{background:var(--accent);border-color:var(--accent);color:#fff}.row{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
label{display:block;margin-top:12px;font-size:14px}input,textarea{display:block;width:100%;font:inherit;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:9px;margin-top:4px}
#days{max-height:9.5rem;overflow:auto}.err{color:#c0392b}.hp{position:absolute;left:-9999px}`;
const shell = (title: string, accent: string, body: string, script = "") => `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${h(title)}</title>
<style>${CSS}:root{--accent:${/^#[0-9a-f]{3,8}$/i.test(accent) ? accent : "#2563eb"}}</style><body><main>${body}</main>${script ? `<script>${script}</script>` : ""}</body></html>`;

function bookingPage(t: Row, project: Row | undefined, reschedule: Row | undefined) {
  const head = `${project ? `<p class="muted">${h(project.name)}</p>` : ""}<h1>${h(t.name)}</h1><p class="muted">${t.duration_min} min · ${h(KINDS[t.location_kind])}</p>${t.description ? `<p>${h(t.description)}</p>` : ""}
    ${reschedule ? `<p class="card">Vous déplacez le rendez-vous du ${h(when(reschedule.start_ts, t.tz))}.</p>` : ""}`;
  const body = `${head}<div class="card" id="pick"><h2 style="margin:0;font-weight:500;font-size:18px">Choisissez un créneau</h2><p class="muted" id="tz"></p><div class="row" id="days" role="group" aria-label="Jours"></div><div class="row" id="slots" role="group" aria-label="Horaires"></div><p id="none" class="muted" hidden>Aucun créneau disponible pour le moment.</p></div>
    <form class="card" id="form" hidden><p><strong id="chosen"></strong></p>
      <label>Nom<input name="name" required maxlength="100" autocomplete="name"></label><label>E-mail<input name="email" type="email" required maxlength="200" autocomplete="email"></label>
      <label>Téléphone <span class="muted">(facultatif)</span><input name="phone" maxlength="40" autocomplete="tel"></label><label>Message <span class="muted">(facultatif)</span><textarea name="message" rows="3" maxlength="2000"></textarea></label>
      <input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true"><p class="err" id="err" role="alert"></p><button class="primary" id="go">${reschedule ? "Confirmer le nouveau créneau" : "Confirmer le rendez-vous"}</button></form>
    <div class="card" id="done" hidden><h2 style="margin:0;font-weight:500">Rendez-vous confirmé</h2><p id="doneText"></p><p><a id="manage" class="btn">Annuler ou déplacer</a></p></div>`;
  const script = `const slug=${JSON.stringify(t.slug)},resched=${JSON.stringify(reschedule?.token ?? "")},horizon=${t.horizon_days};
const $=i=>document.getElementById(i),tz=Intl.DateTimeFormat().resolvedOptions().timeZone;let chosen=0;
$("tz").textContent="Heures affichées dans votre fuseau : "+tz;
const dayKey=s=>new Date(s).toLocaleDateString("en-CA"),fmtDay=s=>new Date(s).toLocaleDateString("fr-FR",{weekday:"short",day:"numeric",month:"short"}),fmtHour=s=>new Date(s).toLocaleTimeString("fr-FR",{hour:"2-digit",minute:"2-digit"});
async function load(){const f=new Date(),to=new Date(Date.now()+horizon*864e5);const r=await fetch("/rdv/"+slug+"/slots?from="+f.getTime()+"&to="+to.getTime());const {slots}=await r.json();const g={};for(const s of slots)(g[dayKey(s)]??=[]).push(s);
const keys=Object.keys(g);$("none").hidden=keys.length>0;$("days").innerHTML="";$("slots").innerHTML="";
keys.forEach((k,i)=>{const b=document.createElement("button");b.type="button";b.textContent=fmtDay(g[k][0]);b.onclick=()=>{[...$("days").children].forEach(x=>x.classList.remove("on"));b.classList.add("on");$("slots").innerHTML="";g[k].forEach(s=>{const c=document.createElement("button");c.type="button";c.textContent=fmtHour(s);c.onclick=()=>{chosen=s;$("chosen").textContent=fmtDay(s)+" à "+fmtHour(s);$("form").hidden=false};$("slots").append(c)})};$("days").append(b);if(i===0)b.click()})}
$("form").onsubmit=async e=>{e.preventDefault();$("err").textContent="";const d=Object.fromEntries(new FormData(e.target));$("go").disabled=true;
const r=await fetch("/rdv/"+slug+"/book",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...d,start:chosen,tz,reschedule:resched||undefined})});const j=await r.json().catch(()=>({}));
$("go").disabled=false;if(!r.ok){$("err").textContent=j.error||"Erreur";if(r.status===409){$("form").hidden=true;load()}return}
$("form").hidden=true;$("pick").hidden=true;$("done").hidden=false;$("doneText").textContent=fmtDay(chosen)+" à "+fmtHour(chosen)+"."+(j.mail?" Un e-mail avec l'invitation vous a été envoyé.":" Gardez le lien ci-dessous pour annuler ou déplacer.");$("manage").href=j.manage;};
load();`;
  return shell(t.name, project?.color ?? "", body, script);
}
function managePage(b: Row) {
  const past = b.start_ts < Date.now(), live = b.status === "confirmed" && !past;
  const body = `<p class="muted">${h(b.project_name ?? "")}</p><h1>${h(b.type_name)}</h1><p>${h(when(b.start_ts, b.client_tz ?? b.tz))}</p><p class="muted">${h(KINDS[b.location_kind])} : ${h(where(b))}</p>
    ${b.status === "cancelled" ? `<p class="card">Ce rendez-vous est annulé. <a href="/rdv/${h(b.slug)}">Reprendre un créneau</a></p>` : past ? `<p class="card muted">Ce rendez-vous est passé.</p>`
      : `<div class="row"><a class="btn primary" href="/rdv/${h(b.slug)}?r=${h(b.token)}">Choisir un autre créneau</a><button id="cancel">Annuler le rendez-vous</button></div><p id="msg"></p>`}`;
  const script = live ? `document.getElementById("cancel").onclick=async()=>{if(!confirm("Annuler ce rendez-vous ?"))return;const r=await fetch(location.pathname+"/cancel",{method:"POST"});document.getElementById("msg").textContent=r.ok?"Rendez-vous annulé.":"Impossible d'annuler.";if(r.ok)setTimeout(()=>location.reload(),800)}` : "";
  return shell(b.type_name, b.project_color ?? "", body, script);
}

// ── Limitation par IP (mémoire du processus) ──
// shortcut: compteur en mémoire, remis à zéro au redémarrage ; suffisant pour une instance auto-hébergée, à persister si l'instance est très exposée.
const hits = new Map<string, number[]>();
function limited(key: string, max: number, windowMs = 3600e3) {
  const now = Date.now(), list = (hits.get(key) ?? []).filter((t) => t > now - windowMs);
  list.push(now); hits.set(key, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => t > now - windowMs)) hits.delete(k);
  return list.length > max;
}

// ── Administration ──
const typeFields = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/, "2 à 41 caractères : minuscules, chiffres, tirets").refine((s) => !RESERVED.has(s), "Identifiant réservé"),
  name: z.string().trim().min(1).max(100), description: z.string().trim().max(1000).default(""),
  project_id: z.string().nullable().default(null),
  duration_min: z.number().int().min(5).max(480), location_kind: z.enum(["meet", "teams", "zoom", "phone", "other"]),
  location_value: z.string().trim().max(300).default(""),
  min_notice_h: z.number().int().min(0).max(720).default(4), buffer_min: z.number().int().min(0).max(120).default(0),
  horizon_days: z.number().int().min(1).max(180).default(60), step_min: z.number().int().min(5).max(240).default(30),
  tz: z.string().refine(validTz, "Fuseau inconnu").default(process.env.DAY_TZ ?? "Europe/Paris"),
  rules: z.partialRecord(z.enum(["0", "1", "2", "3", "4", "5", "6"]), z.array(z.tuple([z.string().regex(HM), z.string().regex(HM)]).refine(([a, b]) => a < b, "Début après la fin")).max(6)).default(WEEK as Record<string, [string, string][]>),
  active: z.boolean().default(true),
}).refine((v) => !["meet", "teams", "zoom"].includes(v.location_kind) || /^https:\/\/\S+$/.test(v.location_value) || (v.location_kind === "meet" && v.location_value === ""), { message: "Collez le lien https de la réunion", path: ["location_value"] });
const bad = (e: unknown) => e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")} : ${i.message}`).join(", ") : (e as Error).message;
/** Un lien Meet vide n'a de sens que si Google Agenda peut le créer à chaque réservation. */
const meetNeedsGoogle = (v: { location_kind: string; location_value: string }) => v.location_kind === "meet" && !v.location_value && providerOf()?.kind !== "google"
  ? "Collez un lien Meet, ou connectez Google Agenda pour qu'il soit créé automatiquement" : "";
const typeOut = (r: Row) => ({ ...r, rules: JSON.parse(r.rules), active: !!r.active, url: `${baseUrl()}/rdv/${r.slug}` });

export function listBookings(q: { project?: string; when?: string } = {}) {
  const w: string[] = [], a: any[] = [];
  if (q.project) { w.push("t.project_id = ?"); a.push(q.project); }
  if (q.when === "upcoming") { w.push("b.status = 'confirmed' AND b.start_ts > ?"); a.push(Date.now()); }
  else if (q.when === "past") { w.push("b.start_ts <= ?"); a.push(Date.now()); }
  return db.prepare(`${joined} ${w.length ? "WHERE " + w.join(" AND ") : ""} ORDER BY b.start_ts ${q.when === "past" ? "DESC" : "ASC"} LIMIT 500`).all(...a) as Row[];
}
const hideToken = ({ token: _t, ...r }: Row) => r;

export function registerRdv(app: Hono, opts: { transport?: Mailer } = {}) {
  if (process.env.DEMO === "1") return; // coordonnées de clients : jamais en démonstration

  // Pages et API publiques, hors /api (aucune session requise)
  const live = (slug: string) => { const t = db.prepare("SELECT * FROM booking_types WHERE slug = ? AND active = 1").get(slug) as Row | undefined; return t && isEnabled("rdv") ? t : undefined; };
  const project = (t: Row) => t.project_id ? db.prepare("SELECT name, color FROM projects WHERE id = ?").get(t.project_id) as Row | undefined : undefined;
  const html = (c: any, s: string, status = 200) => c.html(s, status, { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  const gone = (c: any) => html(c, shell("Introuvable", "", "<h1>Page introuvable</h1><p class=\"muted\">Ce lien de réservation n'est plus actif.</p>"), 404);

  app.get("/rdv/feed/:file", (c) => {
    const given = c.req.param("file").replace(/\.ics$/, ""), good = feedToken();
    if (!isEnabled("rdv") || given.length !== good.length || !timingSafeEqual(Buffer.from(given), Buffer.from(good))) return c.body(null, 404);
    const rows = db.prepare(`${joined} WHERE b.status = 'confirmed' AND b.end_ts > ? ORDER BY b.start_ts`).all(Date.now() - 30 * 864e5) as Row[];
    return c.body(ics(rows, "PUBLISH", mailSetup()?.to ?? ""), 200, { "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "no-store" });
  });
  app.get("/rdv/c/:token", (c) => { const b = isEnabled("rdv") ? byToken(c.req.param("token")) : undefined; return b ? html(c, managePage(b)) : gone(c); });
  app.post("/rdv/c/:token/cancel", async (c) => {
    if (limited(`cancel:${clientIp(c)}`, 20)) return c.json({ error: "Trop de demandes" }, 429);
    const b = isEnabled("rdv") ? byToken(c.req.param("token")) : undefined;
    if (!b || b.start_ts < Date.now()) return c.json({ error: "Introuvable" }, 404);
    const done = cancel(b.id);
    if (!done) return c.json({ error: "Déjà annulé" }, 409);
    void after(done, "cancelled", opts);
    return c.json({ ok: true });
  });
  app.get("/rdv/:slug", (c) => {
    const t = live(c.req.param("slug"));
    if (!t) return gone(c);
    const old = c.req.query("r") ? byToken(c.req.query("r")!) : undefined;
    return html(c, bookingPage(t, project(t), old?.status === "confirmed" && old.type_id === t.id ? old : undefined));
  });
  app.get("/rdv/:slug/slots", async (c) => {
    const t = live(c.req.param("slug"));
    if (!t) return c.json({ error: "Introuvable" }, 404);
    if (limited(`slots:${clientIp(c)}`, 300)) return c.json({ error: "Trop de demandes" }, 429);
    const from = Number(c.req.query("from")), to = Number(c.req.query("to"));
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from || to - from > 190 * 864e5) return c.json({ error: "Période invalide" }, 400);
    return c.json({ slots: freeSlots(t, from, to, Date.now(), await externalBusy(from, to)), tz: t.tz });
  });
  app.post("/rdv/:slug/book", async (c) => {
    const t = live(c.req.param("slug"));
    if (!t) return c.json({ error: "Introuvable" }, 404);
    if (limited(`book:${clientIp(c)}`, 8)) return c.json({ error: "Trop de réservations, réessayez plus tard" }, 429);
    let input: z.infer<typeof bookingFields>;
    try { input = bookingFields.parse(await c.req.json()); } catch { return c.json({ error: "Vérifiez le nom et l'e-mail" }, 400); }
    if (input.website) return c.json({ ok: true, manage: "/" }); // piège anti-robots : on fait semblant sans rien enregistrer
    try {
      const b = book(t, input, await externalBusy(input.start - 864e5, input.start + 864e5));
      void after(b, "created", opts);
      return c.json({ ok: true, manage: `/rdv/c/${b.token}`, mail: !!(opts.transport || mailSetup()) }, 201);
    } catch (e) {
      const m = (e as Error).message;
      return c.json({ error: m }, /plus disponible/.test(m) ? 409 : 400);
    }
  });

  // Administration (session ou clé principale ; /api/rdv est réservé à l'administrateur dans index.ts)
  app.get("/api/rdv", (c) => c.json({
    mail: !!mailSetup(), feed_url: feedUrl(), calendar: providerOf()?.name ?? null, meet_auto: providerOf()?.kind === "google",
    types: (db.prepare("SELECT * FROM booking_types ORDER BY name").all() as Row[]).map(typeOut),
    blocks: db.prepare("SELECT * FROM booking_blocks ORDER BY day").all(),
  }));
  app.get("/api/rdv/bookings", (c) => c.json(listBookings({ project: c.req.query("project"), when: c.req.query("when") }).map(hideToken)));
  app.post("/api/rdv/types", async (c) => {
    try {
      const v = typeFields.parse(await c.req.json()), id = randomUUID();
      if (v.project_id && !db.prepare("SELECT 1 FROM projects WHERE id = ?").get(v.project_id)) return c.json({ error: "Projet introuvable" }, 400);
      if (meetNeedsGoogle(v)) return c.json({ error: meetNeedsGoogle(v) }, 400);
      db.prepare(`INSERT INTO booking_types (id, slug, project_id, name, description, duration_min, location_kind, location_value, min_notice_h, buffer_min, horizon_days, step_min, tz, rules, active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, v.slug, v.project_id, v.name, v.description, v.duration_min, v.location_kind, v.location_value, v.min_notice_h, v.buffer_min, v.horizon_days, v.step_min, v.tz, JSON.stringify(v.rules), Number(v.active), Date.now());
      return c.json({ id, url: `${baseUrl()}/rdv/${v.slug}` }, 201);
    } catch (e) { return c.json({ error: /UNIQUE/.test((e as Error).message) ? "Cet identifiant existe déjà" : bad(e) }, 400); }
  });
  app.patch("/api/rdv/types/:id", async (c) => {
    const cur = db.prepare("SELECT * FROM booking_types WHERE id = ?").get(c.req.param("id")) as Row | undefined;
    if (!cur) return c.json({ error: "Introuvable" }, 404);
    try {
      const v = typeFields.parse({ ...cur, rules: JSON.parse(cur.rules), active: !!cur.active, ...(await c.req.json()) });
      if (v.project_id && !db.prepare("SELECT 1 FROM projects WHERE id = ?").get(v.project_id)) return c.json({ error: "Projet introuvable" }, 400);
      if (meetNeedsGoogle(v)) return c.json({ error: meetNeedsGoogle(v) }, 400);
      db.prepare(`UPDATE booking_types SET slug=?, project_id=?, name=?, description=?, duration_min=?, location_kind=?, location_value=?, min_notice_h=?, buffer_min=?, horizon_days=?, step_min=?, tz=?, rules=?, active=? WHERE id=?`)
        .run(v.slug, v.project_id, v.name, v.description, v.duration_min, v.location_kind, v.location_value, v.min_notice_h, v.buffer_min, v.horizon_days, v.step_min, v.tz, JSON.stringify(v.rules), Number(v.active), cur.id);
      return c.json({ ok: true });
    } catch (e) { return c.json({ error: /UNIQUE/.test((e as Error).message) ? "Cet identifiant existe déjà" : bad(e) }, 400); }
  });
  // Supprimer un type supprime aussi ses RDV (cascade) : on propose plutôt de le désactiver tant qu'il a des RDV à venir.
  app.delete("/api/rdv/types/:id", (c) => {
    const n = (db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE type_id = ? AND status = 'confirmed' AND start_ts > ?").get(c.req.param("id"), Date.now()) as Row).n;
    if (n) return c.json({ error: `${n} rendez-vous à venir : annulez-les ou désactivez le type` }, 409);
    return db.prepare("DELETE FROM booking_types WHERE id = ?").run(c.req.param("id")).changes ? c.json({ ok: true }) : c.json({ error: "Introuvable" }, 404);
  });
  app.post("/api/rdv/bookings/:id/cancel", async (c) => {
    const done = cancel(c.req.param("id"));
    if (!done) return c.json({ error: "Introuvable ou déjà annulé" }, 404);
    void after(done, "cancelled", opts);
    return c.json({ ok: true });
  });
  app.post("/api/rdv/blocks", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    if (!DAY.test(b.day ?? "")) return c.json({ error: "Date AAAA-MM-JJ requise" }, 400);
    db.prepare("INSERT INTO booking_blocks (day, note) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET note = excluded.note").run(b.day, String(b.note ?? "").slice(0, 200));
    return c.json({ ok: true }, 201);
  });
  app.delete("/api/rdv/blocks/:day", (c) => db.prepare("DELETE FROM booking_blocks WHERE day = ?").run(c.req.param("day")).changes ? c.json({ ok: true }) : c.json({ error: "Introuvable" }, 404));
}

export function rdvTools(server: McpServer, readOnly: boolean) {
  const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
  server.registerTool("rdv_types", { description: "Types de rendez-vous et leur lien de réservation public (à envoyer au client), plus l'adresse du flux iCal d'abonnement." },
    async () => json({ feed_url: feedUrl(), types: (db.prepare("SELECT * FROM booking_types ORDER BY name").all() as Row[]).map(typeOut) }));
  server.registerTool("rdv_list", { description: "Rendez-vous réservés, filtrables par projet (id) et par période : upcoming (à venir), past, ou tous.",
    inputSchema: z.object({ project: z.string().optional(), when: z.enum(["upcoming", "past", "all"]).default("upcoming") }) },
    async ({ project, when }) => json(listBookings({ project, when }).map(hideToken)));
  if (readOnly) return;
  server.registerTool("rdv_cancel", { description: "Annule un rendez-vous (le client et vous recevez l'annulation par e-mail).", inputSchema: z.object({ id: z.string() }) },
    async ({ id }) => { const b = cancel(id); if (!b) throw new Error("Rendez-vous introuvable ou déjà annulé"); await after(b, "cancelled"); return json({ ok: true }); });
}
