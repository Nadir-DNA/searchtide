import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db.ts";
import { createContact, getContact, updateContact } from "./business.ts";
import { checkUnsub, enroll, render, runSequences, sendToContact, unsubToken } from "./outreach.ts";

const sent: Record<string, any>[] = [];
const transport = { sendMail: async (m: Record<string, any>) => { sent.push(m); } };

test("variables des modèles", () => {
  assert.equal(render("Bonjour {{prenom}}, {{entreprise}} à {{ville}} !", { name: "Karim Benali", company: "Garage Sud", city: "Lyon" }), "Bonjour Karim, Garage Sud à Lyon !");
  assert.equal(render("Bonjour {{prenom}} {{ville}}, ça va ?", { name: "Léa" }), "Bonjour Léa, ça va ?");
});

test("envoi : lien de désinscription, historique, étape « contacté », refus si désinscrit", async () => {
  const c = createContact({ name: "Léa Martin", email: "lea@exemple.fr" });
  await sendToContact(c.id, "Bonjour {{prenom}}", "Message pour {{entreprise}}", { transport });
  const m = sent.at(-1)!;
  assert.equal(m.to, "lea@exemple.fr"); assert.equal(m.subject, "Bonjour Léa");
  assert.match(m.text, /\/u\/[\w-]+\.[\w-]+/); assert.ok(m.headers["List-Unsubscribe"]);
  assert.equal(getContact(c.id)!.stage, "contacted");
  assert.equal(checkUnsub(unsubToken(c.id)), c.id);
  assert.equal(checkUnsub(c.id + ".faux"), null);
  updateContact(c.id, { opt_out: true });
  await assert.rejects(sendToContact(c.id, "x", "y", { transport }), /ne plus être contacté/);
});

test("séquence : étapes espacées, arrêt quand le contact avance", async () => {
  db.prepare("INSERT INTO templates (id, name, subject, body, created_at) VALUES ('t1', 'Premier', 'Bonjour', 'Corps 1', 0), ('t2', 'Relance', 'Relance', 'Corps 2', 0)").run();
  db.prepare(`INSERT INTO sequences (id, name, steps, created_at) VALUES ('s1', 'Prospection', '[{"delay_days":0,"template_id":"t1"},{"delay_days":3,"template_id":"t2"}]', 0)`).run();
  const a = createContact({ name: "Alpha", email: "a@exemple.fr" });
  const b = createContact({ name: "Bravo", email: "b@exemple.fr" });
  enroll(a.id, "s1", "2026-11-09"); enroll(b.id, "s1", "2026-11-09");
  const mardi10h = new Date("2026-11-10T09:00:00Z");
  assert.deepEqual(await runSequences(mardi10h, { transport }), { sent: 2, stopped: 0 });
  assert.deepEqual(await runSequences(mardi10h, { transport }), { sent: 0, stopped: 0 }, "relance pas encore due");
  updateContact(b.id, { stage: "qualified" });
  assert.deepEqual(await runSequences(new Date("2026-11-13T09:00:00Z"), { transport }), { sent: 1, stopped: 1 });
  assert.deepEqual(await runSequences(new Date("2026-11-14T09:00:00Z"), { transport }), { sent: 0, stopped: 0 }, "samedi : rien");
});
