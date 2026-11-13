import { test } from "node:test";
import assert from "node:assert/strict";
import { busyTimes, deleteEvent, putEvent, resolveCalendar, caldav } from "./caldav.ts";
import { runTest } from "./registry.ts";
import { ics } from "../rdv.ts";

type Call = { method: string; url: string; auth?: string; body?: string };
const calls: Call[] = [];
const xml = (body: string, status = 207) => new Response(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${body}</d:multistatus>`, { status });
const cal = (href: string, name: string, extra = "") => `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>${name}</d:displayname>${extra}</d:prop></d:propstat></d:response>`;
const EVENTS = `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:20261116T080000Z\r\nDTEND:20261116T090000Z\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nDTSTART;TZID=Europe/Paris:20261117T100000\r\nDURATION:PT1H30M\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20261118\r\nDTEND;VALUE=DATE:20261119\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nDTSTART:20261119T080000Z\r\nDTEND:20261119T090000Z\r\nTRANSP:TRANSPARENT\r\nEND:VEVENT\r\nEND:VCALENDAR`;

// Faux serveur : racine → principal → maison → deux agendas ; iCloud-like : redirection vers un autre hôte.
const server: typeof fetch = async (u, i = {}) => {
  const url = String(u), method = String(i.method), auth = (i.headers as Record<string, string>).Authorization;
  calls.push({ method, url, auth, body: i.body as string | undefined });
  if (url.startsWith("https://dav.exemple.test/.well-known/caldav")) return new Response(null, { status: 301, headers: { location: "https://p01.exemple.test/principals/me/" } });
  if (url === "https://p01.exemple.test/principals/me/") return xml(`<d:response><d:href>/principals/me/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/principals/me/</d:href></d:current-user-principal><c:calendar-home-set><d:href>/cals/me/</d:href></c:calendar-home-set></d:prop></d:propstat></d:response>`);
  if (url === "https://p01.exemple.test/cals/me/") return xml(cal("/cals/me/", "Dossier").replace("<c:calendar/>", "") + cal("/cals/me/travail/", "Travail") + cal("/cals/me/perso/", "Perso"));
  if (method === "REPORT") return xml(`<d:response><d:propstat><d:prop><c:calendar-data>${EVENTS.replace(/&/g, "&amp;")}</c:calendar-data></d:prop></d:propstat></d:response>`);
  if (method === "PUT") return new Response(null, { status: 201 });
  if (method === "DELETE") return new Response(null, { status: 404 });
  return new Response("?", { status: 500 });
};
const cfg = (config = {}) => ({ config: { url: "https://dav.exemple.test/", user: "moi@exemple.test", ...config }, secrets: { pass: "mdp-appli-1234" } });

test("découverte : redirection, principal, maison, premier agenda ou agenda nommé ; identifiants conservés après redirection", async () => {
  calls.length = 0;
  assert.deepEqual(await resolveCalendar(cfg(), server), { url: "https://p01.exemple.test/cals/me/travail/", name: "Travail" });
  assert.ok(calls.every((c) => c.auth?.startsWith("Basic ")), "l'identification suit les redirections");
  assert.equal((await resolveCalendar(cfg({ calendar: "perso" }), server)).name, "Perso");
  await assert.rejects(resolveCalendar(cfg({ calendar: "inconnu" }), server), /introuvable/);
});

test("https obligatoire, identifiants refusés = erreur claire", async () => {
  await assert.rejects(resolveCalendar(cfg({ url: "http://dav.exemple.test/" }), server), /https/);
  await assert.rejects(resolveCalendar(cfg(), async () => new Response("", { status: 401 })), /mot de passe/i);
});

test("occupations : UTC, fuseau + durée ; journées entières et événements « libres » ignorés", async () => {
  const busy = await busyTimes(cfg({ calendar_url: "https://p01.exemple.test/cals/me/perso/" }), Date.parse("2026-11-16T00:00:00Z"), Date.parse("2026-11-20T00:00:00Z"), server);
  assert.deepEqual(busy, [[Date.parse("2026-11-16T08:00:00Z"), Date.parse("2026-11-16T09:00:00Z")], [Date.parse("2026-11-17T09:00:00Z"), Date.parse("2026-11-17T10:30:00Z")]]);
  assert.match(calls.at(-1)!.body!, /expand start="20261116T000000Z" end="20261120T000000Z"/);
});

test("écriture : PUT nommé d'après l'UID sans METHOD, DELETE tolère 404", async () => {
  calls.length = 0;
  const c = cfg({ calendar_url: "https://p01.exemple.test/cals/me/perso/" });
  const b = { id: "abc", created_at: 0, start_ts: 0, end_ts: 1800e3, status: "confirmed", type_name: "Appel", name: "Léa", email: "l@e.fr", phone: "", message: "", location_kind: "meet", location_value: "https://x.test" };
  await putEvent(c, "abc", ics([b], "STORE"), server);
  await deleteEvent(c, "abc", server);
  assert.deepEqual(calls.map((x) => [x.method, x.url]), [["PUT", "https://p01.exemple.test/cals/me/perso/abc.ics"], ["DELETE", "https://p01.exemple.test/cals/me/perso/abc.ics"]]);
  assert.ok(!/METHOD:/.test(calls[0].body!)); assert.match(calls[0].body!, /UID:abc@searchtide/);
});

test("test() du connecteur : agenda trouvé, réglages gardés, aucun secret dans le résultat", async () => {
  const r = await runTest(caldav, cfg(), { fetch: server, now: () => new Date(), timeoutMs: 5000, smtp: () => { throw 0; }, pg: () => { throw 0; } } as any);
  assert.equal(r.ok, true); assert.equal(r.settings?.calendar_url, "https://p01.exemple.test/cals/me/travail/");
  assert.ok(!JSON.stringify(r).includes("mdp-appli-1234"));
});
