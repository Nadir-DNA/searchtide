// Module Rendez-vous avec Google Agenda connecté : créneaux écartés, lien Meet généré et envoyé, suppression à l'annulation.
import { test } from "node:test";
import assert from "node:assert/strict";
process.env.SECRET = "g".repeat(40);
import { db } from "./db.ts";
import { createConnection } from "./connections.ts";
import { after, book, cancel, externalBusy, freeSlots, providerOf } from "./rdv.ts";

type Row = Record<string, any>;
const calls: { method: string; url: string }[] = [];
const real = globalThis.fetch;
globalThis.fetch = (async (u: any, i: RequestInit = {}) => {
  const url = String(u), method = String(i.method ?? "GET"); calls.push({ method, url });
  const j = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });
  if (url.endsWith("/v1/google/refresh")) return j({ access_token: "ya29.X", expires_in: 3599 });
  if (url.endsWith("/freeBusy")) return j({ calendars: { primary: { busy: [{ start: "2030-01-14T08:30:00Z", end: "2030-01-14T09:30:00Z" }] } } });
  if (method === "POST" && url.includes("/events?")) return j({ hangoutLink: "https://meet.google.com/zzz-yyyy-xxx" });
  if (method === "DELETE") return new Response(null, { status: 204 });
  return j({}, 404);
}) as typeof fetch;

db.prepare(`INSERT INTO booking_types (id, slug, name, duration_min, location_kind, location_value, min_notice_h, horizon_days, step_min, tz, rules, created_at)
  VALUES ('g1', 'visio', 'Visio', 30, 'meet', '', 0, 3650, 30, 'Europe/Paris', '{"1":[["09:00","12:00"]]}', 0)`).run();
const type = () => db.prepare("SELECT * FROM booking_types WHERE id = 'g1'").get() as Row;
const lundi = Date.parse("2030-01-14T08:00:00Z"); // 9 h Paris

test("sans connexion Google : aucun agenda, aucun créneau écarté", async () => {
  assert.equal(providerOf(), null);
  assert.deepEqual(await externalBusy(lundi, lundi + 3600e3), []);
});

test("Google connecté : occupations lues, RDV écrit avec lien Meet, lien dans l'e-mail, suppression à l'annulation", async () => {
  createConnection({ kind: "gcal", label: "moi@gmail.com", config: { relay: true, relay_url: "https://connect.test", email: "moi@gmail.com" }, secrets: { refresh_token: "1//0g-refresh-0123456789abcdef" }, fingerprintOf: "gcal:moi@gmail.com" });
  assert.equal(providerOf()?.kind, "google");

  const busy = await externalBusy(lundi, lundi + 3 * 3600e3);
  assert.equal(busy.length, 1);
  const free = freeSlots(type(), lundi, lundi + 3 * 3600e3, Date.now(), busy);
  assert.ok(!free.includes(Date.parse("2030-01-14T08:30:00Z")) && !free.includes(Date.parse("2030-01-14T09:00:00Z")));
  assert.ok(free.includes(lundi));

  const b = book(type(), { name: "Léa", email: "lea@exemple.fr", phone: "", message: "", start: lundi }, busy);
  const sent: Row[] = [];
  process.env.RDV_NOTIFY_TO = "moi@exemple.fr";
  await after(b, "created", { transport: { sendMail: async (m: Row) => { sent.push(m); } } });
  assert.match(sent[0].text, /meet\.google\.com\/zzz-yyyy-xxx/, "l'invitation porte le lien Meet créé par Google");
  assert.match(sent[0].icalEvent.content, /LOCATION:https:\/\/meet\.google\.com\/zzz-yyyy-xxx/);
  assert.equal((db.prepare("SELECT location_override FROM bookings WHERE id = ?").get(b.id) as Row).location_override, "https://meet.google.com/zzz-yyyy-xxx");
  assert.ok(calls.some((c) => c.method === "POST" && /conferenceDataVersion=1/.test(c.url)));

  await after(cancel(b.id)!, "cancelled", { transport: { sendMail: async () => {} } });
  assert.ok(calls.some((c) => c.method === "DELETE" && c.url.includes(b.id.replace(/-/g, ""))));
});

test("l'accès Google retiré (reconnect) : le module continue sans agenda", () => {
  db.prepare("UPDATE connections SET status = 'reconnect' WHERE kind = 'gcal'").run();
  assert.equal(providerOf(), null);
  globalThis.fetch = real;
});
