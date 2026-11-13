import { test } from "node:test";
import assert from "node:assert/strict";
import { accessToken, busyTimes, deleteEvent, eventId, putEvent, whoami } from "./gcal.ts";

type Call = { method: string; url: string; body?: any; auth?: string };
let calls: Call[] = [], refreshes = 0;
const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const google: typeof fetch = async (u, i = {}) => {
  const url = String(u), method = String(i.method ?? "GET"), headers = (i.headers ?? {}) as Record<string, string>;
  calls.push({ method, url, auth: headers.Authorization, body: i.body ? JSON.parse(String(i.body)) : undefined });
  if (url.endsWith("/v1/google/refresh")) { refreshes++; return JSON.parse(String(i.body)).refresh_token.startsWith("gone") ? j({ error: "reconnect" }, 401) : j({ access_token: "ya29.T" + refreshes, expires_in: 3599 }); }
  if (url.endsWith("/freeBusy")) return j({ calendars: { primary: { busy: [{ start: "2026-11-16T08:00:00Z", end: "2026-11-16T09:00:00Z" }] } } });
  if (method === "POST" && url.includes("/events?")) return j({ id: "x", hangoutLink: "https://meet.google.com/abc-defg-hij" });
  if (method === "DELETE") return new Response(null, { status: 410 });
  if (url.includes("/events?maxResults=1")) return j({ summary: "moi@gmail.com", timeZone: "Europe/Paris" });
  return j({}, 404);
};
const g = (refresh = "1//0g-refresh-token-0123456789") => ({ config: { relay_url: "https://connect.test/" }, secrets: { refresh_token: refresh } });

test("jeton d'accès : demandé au relais une fois puis gardé ; accès retiré = erreur de reconnexion", async () => {
  calls = []; refreshes = 0;
  assert.equal(await accessToken(g(), google), "ya29.T1"); assert.equal(await accessToken(g(), google), "ya29.T1");
  assert.equal(refreshes, 1); assert.equal(calls[0].url, "https://connect.test/v1/google/refresh");
  await assert.rejects(accessToken(g("gone-refresh-token-0123456789"), google), /reconnectez/);
  await assert.rejects(accessToken({ config: {}, secrets: {} }, google), /incomplète/);
});

test("occupations : plages en ms UTC, période découpée en tranches de 60 jours", async () => {
  calls = [];
  const busy = await busyTimes(g(), Date.parse("2026-11-01T00:00:00Z"), Date.parse("2027-03-15T00:00:00Z"), google);
  const fb = calls.filter((c) => c.url.endsWith("/freeBusy"));
  assert.equal(fb.length, 3); assert.equal(busy.length, 3);
  assert.deepEqual(busy[0], [Date.parse("2026-11-16T08:00:00Z"), Date.parse("2026-11-16T09:00:00Z")]);
  assert.match(fb[0].auth!, /^Bearer ya29\./); assert.deepEqual(fb[0].body.items, [{ id: "primary" }]);
});

test("événement : identifiant fixe sans tiret, lien Meet demandé et lu, pas d'invité ; suppression tolère 410", async () => {
  calls = [];
  const id = "3f2c9d1e-aaaa-4bbb-8ccc-0123456789ab";
  const meet = await putEvent(g(), { id, summary: "Appel — Léa", description: "d", location: "", start: Date.parse("2026-11-16T08:00:00Z"), end: Date.parse("2026-11-16T08:30:00Z"), tz: "Europe/Paris", meet: true }, google);
  assert.equal(meet, "https://meet.google.com/abc-defg-hij");
  const post = calls.find((c) => c.method === "POST" && c.url.includes("/events?"))!;
  assert.equal(post.body.id, eventId(id)); assert.match(eventId(id), /^[a-f0-9]{32}$/);
  assert.match(post.url, /conferenceDataVersion=1/); assert.equal(post.body.conferenceData.createRequest.conferenceSolutionKey.type, "hangoutsMeet");
  assert.equal(post.body.attendees, undefined, "Google n'envoie aucune invitation : c'est l'e-mail de Searchtide qui s'en charge");
  assert.equal(post.body.location, undefined);
  await deleteEvent(g(), id, google);
  assert.match(calls.at(-1)!.url, new RegExp(`/events/${eventId(id)}\\?`));
});

test("whoami : adresse du calendrier lue sans autre permission que « événements »", async () => {
  assert.deepEqual(await whoami(g(), google), { name: "moi@gmail.com", tz: "Europe/Paris" });
});
