import { test } from "node:test";
import assert from "node:assert/strict";
import { businessSummary, createContact, getContact, importContacts, listContacts, listPublications, savePublication, updateContact } from "./business.ts";

test("import : doublons par téléphone, email ou nom + ville", () => {
  const r = importContacts([
    { name: "Garage Martin", phone: "06 12 34 56 78", city: "Lyon" },
    { name: "Garage Martin bis", phone: "0612345678" },          // même téléphone
    { name: "Salon Rose", email: "Rose@Exemple.fr" },
    { name: "Autre", email: "rose@exemple.fr" },                 // même email
    { name: "garage martin", city: "lyon" },                     // même nom, même ville
    { name: "" },                                                // invalide
    { name: "💧" },                                              // sans lettres : invalide
    { name: "Plombier Sud", phone: "Pose de vos équipements" },  // téléphone mal rempli : ignoré
  ], { source: "test", project: "exemple" });
  assert.deepEqual(r, { added: 3, skipped: 3, invalid: 2 });
  assert.equal(listContacts({ q: "Plombier Sud" }).rows[0]!.phone, null);
  assert.equal(listContacts({ source: "test" }).total, 3);
  assert.equal(listContacts({ q: "rose" }).rows[0]!.project, "exemple");
});

test("changement d'étape et relance due", () => {
  const c = createContact({ name: "Coach Durand", project: "exemple", value: 1200 });
  const u = updateContact(c.id, { stage: "proposal", next_at: "2000-01-01", next_action: "Rappeler" })!;
  assert.equal(u.stage, "proposal");
  assert.equal(u.activities[0].text, "new → proposal");
  assert.ok(listContacts({ todo: true }).rows.some((r: any) => r.id === c.id));
  updateContact(c.id, { opt_out: true });
  assert.ok(!listContacts({ todo: true }).rows.some((r: any) => r.id === c.id), "plus de relance après opt-out");
  assert.throws(() => updateContact(c.id, { stage: "inconnu" }));
  assert.equal(getContact(c.id)!.stage, "proposal");
  assert.ok(businessSummary().pipelineValue >= 1200);
});

test("publications : création, modification, filtre par dates", () => {
  const p = savePublication(null, { day: "2026-11-10", title: "Vidéo de lancement", network: "tiktok" }) as any;
  savePublication(p.id, { status: "published" });
  const rows = listPublications({ from: "2026-11-01", to: "2026-11-30" }) as any[];
  assert.equal(rows.find((r) => r.id === p.id)?.status, "published");
  assert.equal(savePublication("absent", { title: "x" }), null);
  assert.throws(() => savePublication(null, { day: "10/11/2026", title: "x" }));
});

test("formulaire de site : création puis note sur le même contact", async () => {
  const { inboundLead, getContact } = await import("./business.ts");
  const a = inboundLead({ name: "Paul Garage", email: "Paul@exemple.fr", form: "devis", message: "Besoin d'un devis", project: "exemple", source: "site-exemple" });
  assert.ok(a.created);
  const b = inboundLead({ name: "Paul", email: "paul@exemple.fr", form: "rdv", message: "Rappel svp" });
  assert.equal(b.id, a.id); assert.equal(b.created, false);
  const c = getContact(a.id)!;
  assert.equal(c.activities.length, 2); assert.equal(c.next_action, "Répondre à la demande");
});

test("doublons : détection et fusion", async () => {
  const { duplicatesOf, mergeContacts, addActivity, getContact } = await import("./business.ts");
  const a = createContact({ name: "Boulangerie Dupont", phone: "06 11 22 33 44" });
  const b = createContact({ name: "B. Dupont", phone: "+33 6 11 22 33 44", email: "dupont@pain.fr", tags: ["vip"] });
  addActivity(b.id, "note", "Appelé lundi");
  assert.deepEqual(duplicatesOf(a.id).map((d: any) => d.id), [b.id]);
  const m = mergeContacts(a.id, b.id);
  assert.equal(m.email, "dupont@pain.fr"); assert.deepEqual(m.tags, ["vip"]);
  assert.ok(m.activities.some((x: any) => x.text === "Appelé lundi"));
  assert.equal(getContact(b.id), undefined);
});

test("formulaire : date de relance vide acceptée", () => {
  const c = createContact({ name: "Sans relance", next_at: "", email: "", value: null });
  assert.equal(c.next_at, null);
  assert.equal(updateContact(c.id, { next_at: "" })!.next_at, null);
  assert.throws(() => updateContact(c.id, { next_at: "demain" }));
});
