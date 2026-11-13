import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db.ts";
import { book, cancel, freeSlots, ics, notify, zonedTs } from "./rdv.ts";

type Row = Record<string, any>;
const rules = JSON.stringify({ 1: [["09:00", "12:00"]], 2: [["09:00", "12:00"]] }); // lundi et mardi matin
db.prepare(`INSERT INTO booking_types (id, slug, name, duration_min, location_kind, location_value, min_notice_h, buffer_min, horizon_days, step_min, tz, rules, created_at)
  VALUES ('t1', 'decouverte', 'Appel découverte', 30, 'meet', 'https://meet.google.com/abc', 0, 0, 60, 30, 'Europe/Paris', ?, 0)`).run(rules);
const type = () => db.prepare("SELECT * FROM booking_types WHERE id = 't1'").get() as Row;
// Lundi 16 nov. 2026 : heure d'hiver (UTC+1)
const NOW = Date.parse("2026-11-13T12:00:00Z");
const range = (a: string, b: string) => [Date.parse(a), Date.parse(b)] as const;

test("fuseau : 9 h à Paris en hiver = 8 h UTC, en été = 7 h UTC", () => {
  assert.equal(zonedTs("2026-11-16", "09:00", "Europe/Paris"), Date.parse("2026-11-16T08:00:00Z"));
  assert.equal(zonedTs("2026-07-15", "09:00", "Europe/Paris"), Date.parse("2026-07-15T07:00:00Z"));
});

test("créneaux : seulement lundi et mardi matin, pas de week-end", () => {
  const s = freeSlots(type(), ...range("2026-11-13T00:00:00Z", "2026-11-22T00:00:00Z"), NOW);
  assert.equal(s.length, 12); // 6 créneaux de 30 min × 2 jours
  assert.equal(s[0], Date.parse("2026-11-16T08:00:00Z"));
  assert.equal(s.at(-1), Date.parse("2026-11-17T10:30:00Z"));
});

test("jour bloqué et préavis", () => {
  db.prepare("INSERT INTO booking_blocks (day) VALUES ('2026-11-16')").run();
  assert.equal(freeSlots(type(), ...range("2026-11-13T00:00:00Z", "2026-11-22T00:00:00Z"), NOW).length, 6);
  db.prepare("DELETE FROM booking_blocks").run();
  db.prepare("UPDATE booking_types SET min_notice_h = 72 WHERE id = 't1'").run(); // 13 nov 12 h + 72 h = 16 nov 12 h UTC : lundi écarté
  assert.equal(freeSlots(type(), ...range("2026-11-13T00:00:00Z", "2026-11-22T00:00:00Z"), NOW).length, 6);
  db.prepare("UPDATE booking_types SET min_notice_h = 0 WHERE id = 't1'").run();
});

const who = { name: "Léa", email: "Lea@Exemple.fr", phone: "", message: "Bonjour" };
const slot = Date.parse("2026-11-16T08:30:00Z");

test("réservation : créneau pris, tampon, refus de double réservation", () => {
  // freeSlots lit l'heure réelle (now) : on se place dans le futur lointain en décalant la date des RDV de test
  const t = { ...type(), horizon_days: 3650, min_notice_h: 0 };
  const future = Date.parse("2030-01-07T09:30:00Z"); // lundi 7 janv. 2030, 10 h 30 Paris
  assert.ok(freeSlots(t, future, future).includes(future));
  const b = book(t, { ...who, start: future });
  assert.equal(b.email, "lea@exemple.fr");
  assert.equal(b.end_ts, future + 30 * 60e3);
  assert.ok(!freeSlots(t, future, future).includes(future));
  assert.throws(() => book(t, { ...who, start: future }), /plus disponible/);
  db.prepare("UPDATE booking_types SET buffer_min = 30 WHERE id = 't1'").run();
  const next = future + 30 * 60e3;
  assert.ok(!freeSlots({ ...t, buffer_min: 30 }, next, next).includes(next), "le tampon écarte le créneau collé");
  db.prepare("UPDATE booking_types SET buffer_min = 0 WHERE id = 't1'").run();
  cancel(b.id);
  assert.ok(freeSlots(t, future, future).includes(future), "annuler libère le créneau");
});

test("report : l'ancien RDV est annulé en même temps, échec = rien ne change", () => {
  const t = { ...type(), horizon_days: 3650, min_notice_h: 0 };
  const a = Date.parse("2030-01-08T08:00:00Z"), z = Date.parse("2030-01-08T08:30:00Z");
  const first = book(t, { ...who, start: a });
  const moved = book(t, { ...who, start: z, reschedule: first.token });
  const row = (id: string) => db.prepare("SELECT status FROM bookings WHERE id = ?").get(id) as Row;
  assert.equal(row(first.id).status, "cancelled"); assert.equal(row(moved.id).status, "confirmed");
  const third = Date.parse("2030-01-08T09:00:00Z");
  assert.throws(() => book(t, { ...who, start: 12345, reschedule: moved.token }), /plus disponible/);
  assert.equal(row(moved.id).status, "confirmed", "transaction annulée : le RDV d'origine reste");
  assert.ok(third);
});

test("limite de 3 RDV à venir par e-mail et par type", () => {
  const t = { ...type(), horizon_days: 3650, min_notice_h: 0 };
  const day = (h: string) => Date.parse(`2030-01-14T${h}:00Z`);
  const me = { ...who, email: "spam@exemple.fr" };
  for (const h of ["08:00", "08:30", "09:00"]) book(t, { ...me, start: day(h) });
  assert.throws(() => book(t, { ...me, start: day("09:30") }), /3 rendez-vous/);
});

test("ics : champs, échappement, annulation", () => {
  const b: Row = { id: "x1", created_at: 0, start_ts: Date.parse("2026-11-16T08:00:00Z"), end_ts: Date.parse("2026-11-16T08:30:00Z"), status: "confirmed",
    type_name: "Appel", name: "Léa; Martin", email: "lea@exemple.fr", phone: "", message: "a, b\nc", location_kind: "meet", location_value: "https://meet.google.com/abc" };
  const out = ics([b], "REQUEST", "moi@exemple.fr");
  assert.match(out, /METHOD:REQUEST/); assert.match(out, /DTSTART:20261116T080000Z/); assert.match(out, /UID:x1@searchtide/);
  assert.match(out, /SUMMARY:Appel — Léa\\; Martin/); assert.match(out, /ORGANIZER:mailto:moi@exemple.fr/);
  assert.match(ics([{ ...b, status: "cancelled" }], "CANCEL"), /STATUS:CANCELLED[\s\S]*SEQUENCE:1/);
  assert.ok(out.split("\r\n").every((l) => l.length <= 73));
});

test("e-mails : client et hôte reçoivent l'invitation, une panne SMTP n'échoue pas", async () => {
  process.env.RDV_NOTIFY_TO = "moi@exemple.fr";
  const sent: Row[] = [];
  const b = db.prepare("SELECT b.*, t.name AS type_name, t.slug, t.location_kind, t.location_value, t.duration_min, t.tz FROM bookings b JOIN booking_types t ON t.id = b.type_id LIMIT 1").get() as Row;
  const r = await notify(b, "created", { transport: { sendMail: async (m: Row) => { sent.push(m); } } });
  assert.equal(r.sent, true); assert.deepEqual(sent.map((m) => m.to), [b.email, "moi@exemple.fr"]);
  assert.equal(sent[0].icalEvent.method, "REQUEST"); assert.match(sent[0].text, new RegExp(`/rdv/c/${b.token}`));
  const down = await notify(b, "cancelled", { transport: { sendMail: async () => { throw new Error("SMTP hors service"); } } });
  assert.equal(down.sent, false);
});

test("agenda externe : une plage occupée écarte les créneaux qu'elle touche, tampon compris", () => {
  const t = { ...type(), horizon_days: 3650, min_notice_h: 0 };
  const lundi = Date.parse("2030-01-21T08:00:00Z"); // 9 h Paris
  const all = freeSlots(t, lundi, lundi + 3 * 3600e3);
  assert.equal(all.length, 6);
  const busy: [number, number][] = [[lundi + 30 * 60e3, lundi + 75 * 60e3]]; // 9 h 30 – 10 h 15
  const left = freeSlots(t, lundi, lundi + 3 * 3600e3, Date.now(), busy);
  assert.deepEqual(all.filter((s) => !left.includes(s)), [lundi + 30 * 60e3, lundi + 60 * 60e3]);
  assert.equal(freeSlots({ ...t, buffer_min: 30 }, lundi, lundi + 3 * 3600e3, Date.now(), busy).includes(lundi), false, "le tampon écarte aussi le créneau d'avant");
  assert.throws(() => book(t, { ...who, email: "x@exemple.fr", start: lundi + 30 * 60e3 }, busy), /plus disponible/);
});
