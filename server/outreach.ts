// Prospection par e-mail : modèles avec variables, envoi depuis la fiche, séquences de relance, désinscription.
// Garde-fous : jamais d'envoi à un contact « ne plus contacter », lien de désinscription dans chaque message,
// plafond quotidien, envois automatiques en semaine de 9 h à 18 h (heure de Paris).
import type { Hono } from "hono";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mailSetup } from "./connectors/channels.ts";
import { z } from "zod";
import { db, localDay } from "./db.ts";
import { migrate } from "./migrations.ts";
import { addActivity, getContact, updateContact } from "./business.ts";

migrate("2026-11-09-prospection", `
CREATE TABLE templates (id TEXT PRIMARY KEY, name TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE sequences (id TEXT PRIMARY KEY, name TEXT NOT NULL, steps TEXT NOT NULL DEFAULT '[]', active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
CREATE TABLE enrollments (
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  sequence_id TEXT NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  step INTEGER NOT NULL DEFAULT 0,          -- prochaine étape à envoyer
  next_at TEXT NOT NULL,                    -- AAAA-MM-JJ
  status TEXT NOT NULL DEFAULT 'active',    -- active | stopped | done
  reason TEXT, started_at INTEGER NOT NULL,
  PRIMARY KEY (contact_id, sequence_id)
);
`);

type Row = Record<string, any>;
const SECRET = process.env.SECRET ?? "dev-secret";
const DAILY_LIMIT = Number(process.env.OUTREACH_DAILY_LIMIT ?? 40);
const templateFields = z.object({ name: z.string().trim().min(1).max(100), subject: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(10_000) });
const sequenceFields = z.object({
  name: z.string().trim().min(1).max(100),
  steps: z.array(z.object({ delay_days: z.number().int().min(0).max(90), template_id: z.string() })).min(1).max(10),
  active: z.boolean().default(true),
});

export const unsubToken = (contactId: string) => `${contactId}.${createHmac("sha256", SECRET).update(`unsub:${contactId}`).digest("base64url").slice(0, 22)}`;
export function checkUnsub(token: string) {
  const [id, sig] = token.split(".");
  if (!id || !sig) return null;
  const good = unsubToken(id).split(".")[1];
  return good.length === sig.length && timingSafeEqual(Buffer.from(good), Buffer.from(sig)) ? id : null;
}

/** Remplit {{prenom}}, {{nom}}, {{entreprise}}, {{ville}}, {{secteur}}, {{site}} ; une variable vide disparaît proprement. */
export function render(text: string, c: Row) {
  const first = String(c.name ?? "").trim().split(/\s+/)[0] ?? "";
  const vars: Record<string, string> = { prenom: first, nom: c.name ?? "", entreprise: c.company ?? c.name ?? "", ville: c.city ?? "", secteur: c.sector ?? "", site: c.site_url ?? "" };
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => vars[k.toLowerCase()] ?? "").replace(/ +([,.])/g, "$1").replace(/[ \t]{2,}/g, " ");
}

const sentToday = () => (db.prepare("SELECT COUNT(*) AS n FROM activities WHERE kind = 'email' AND ts >= ?").get(Date.parse(localDay() + "T00:00:00")) as Row).n as number;
export const mailReady = () => !!mailSetup();

/** Envoie un e-mail à un contact et l'enregistre dans son historique. `transport` : injectable pour les tests. */
export async function sendToContact(contactId: string, subject: string, body: string, opts: { transport?: { sendMail: (m: Row) => Promise<unknown> } } = {}) {
  const c = getContact(contactId);
  if (!c) throw new Error("Contact introuvable");
  if (c.opt_out) throw new Error("Ce contact a demandé à ne plus être contacté");
  if (!c.email) throw new Error("Ce contact n'a pas d'adresse e-mail");
  if (sentToday() >= DAILY_LIMIT) throw new Error(`Plafond de ${DAILY_LIMIT} e-mails par jour atteint (protège la réputation de votre adresse)`);
  const mail = opts.transport ? null : mailSetup();
  if (!opts.transport && !mail) throw new Error("Envoi non configuré : ajoutez E-mail (SMTP) dans Connexions");
  const s = render(subject, c), text = render(body, c);
  const unsub = `${process.env.PUBLIC_URL ?? ""}/u/${unsubToken(c.id)}`;
  await (opts.transport ?? mail!.transport).sendMail({
    from: process.env.OUTREACH_FROM || mail?.from || process.env.REPORT_FROM || process.env.REPORT_TO,
    to: c.email, subject: s,
    text: `${text}\n\n—\nPour ne plus recevoir de messages de ma part : ${unsub}`,
    headers: { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  });
  addActivity(c.id, "email", `${s}\n\n${text}`);
  if (c.stage === "new") updateContact(c.id, { stage: "contacted" });
  return { ok: true, to: c.email };
}

export function enroll(contactId: string, sequenceId: string, start = localDay()) {
  const seq = db.prepare("SELECT * FROM sequences WHERE id = ?").get(sequenceId) as Row | undefined;
  if (!seq) throw new Error("Séquence introuvable");
  const steps = JSON.parse(seq.steps);
  const next = new Date(Date.parse(start) + steps[0].delay_days * 86400000).toISOString().slice(0, 10);
  db.prepare(`INSERT INTO enrollments (contact_id, sequence_id, step, next_at, status, started_at) VALUES (?, ?, 0, ?, 'active', ?)
    ON CONFLICT DO UPDATE SET step = 0, next_at = excluded.next_at, status = 'active', reason = NULL, started_at = excluded.started_at`).run(contactId, sequenceId, next, Date.now());
  addActivity(contactId, "note", `Ajouté à la séquence « ${seq.name} »`);
}

/** Envoie les étapes dues. S'arrête dès que le contact avance (intéressé, proposition, gagné, perdu) ou se désinscrit. */
export async function runSequences(now = new Date(), opts: { transport?: { sendMail: (m: Row) => Promise<unknown> }; force?: boolean } = {}) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", weekday: "short", hour: "numeric", hourCycle: "h23" }).formatToParts(now).map((x) => [x.type, x.value]));
  if (!opts.force && (["Sat", "Sun"].includes(p.weekday) || +p.hour < 9 || +p.hour >= 18)) return { sent: 0, stopped: 0 };
  let sent = 0, stopped = 0;
  const due = db.prepare(`SELECT e.*, s.steps, s.name AS seq_name, s.active FROM enrollments e JOIN sequences s ON s.id = e.sequence_id
    WHERE e.status = 'active' AND e.next_at <= ? ORDER BY e.next_at`).all(localDay(now)) as Row[];
  for (const e of due) {
    const c = getContact(e.contact_id);
    const stop = (reason: string) => { db.prepare("UPDATE enrollments SET status = 'stopped', reason = ? WHERE contact_id = ? AND sequence_id = ?").run(reason, e.contact_id, e.sequence_id); stopped++; };
    if (!e.active) continue;
    if (!c || c.opt_out) { stop("désinscrit"); continue; }
    if (["qualified", "proposal", "won", "lost"].includes(c.stage)) { stop("a avancé dans le pipeline"); continue; }
    const steps = JSON.parse(e.steps);
    const t = db.prepare("SELECT * FROM templates WHERE id = ?").get(steps[e.step]?.template_id) as Row | undefined;
    if (!t) { stop("modèle supprimé"); continue; }
    try {
      await sendToContact(c.id, t.subject, t.body, opts);
      sent++;
    } catch (err) {
      if (/Plafond/.test((err as Error).message)) break;
      stop((err as Error).message.slice(0, 200)); continue;
    }
    const nextStep = e.step + 1;
    if (nextStep >= steps.length) db.prepare("UPDATE enrollments SET status = 'done', step = ? WHERE contact_id = ? AND sequence_id = ?").run(nextStep, e.contact_id, e.sequence_id);
    else db.prepare("UPDATE enrollments SET step = ?, next_at = ? WHERE contact_id = ? AND sequence_id = ?")
      .run(nextStep, new Date(Date.parse(localDay(now)) + steps[nextStep].delay_days * 86400000).toISOString().slice(0, 10), e.contact_id, e.sequence_id);
  }
  return { sent, stopped };
}

export function registerOutreach(app: Hono) {
  if (process.env.DEMO === "1") return; // prospection et désinscription : jamais en démonstration
  const bad = (e: unknown) => e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")} : ${i.message}`).join(", ") : (e as Error).message;

  // Désinscription publique (hors /api) : un clic suffit, sans connexion
  const unsubscribe = (token: string) => {
    const id = checkUnsub(token);
    if (id && getContact(id)) { updateContact(id, { opt_out: true }); db.prepare("UPDATE enrollments SET status = 'stopped', reason = 'désinscrit' WHERE contact_id = ? AND status = 'active'").run(id); }
    return !!id;
  };
  app.get("/u/:token", (c) => c.html(`<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Désinscription</title>
    <body style="font-family:system-ui,sans-serif;max-width:480px;margin:15vh auto;padding:0 16px;line-height:1.5;color:#111">
    ${unsubscribe(c.req.param("token")) ? "<h1 style=\"font-weight:400\">C'est fait.</h1><p>Vous ne recevrez plus de messages de ma part. Merci et bonne continuation.</p>" : "<h1 style=\"font-weight:400\">Lien invalide</h1><p>Répondez simplement à l'e-mail reçu avec « stop » : je vous retire à la main.</p>"}</body></html>`));
  app.post("/u/:token", (c) => unsubscribe(c.req.param("token")) ? c.body(null, 204) : c.body(null, 400)); // désinscription en un clic (RFC 8058)

  app.get("/api/outreach", (c) => c.json({
    mail: mailReady(), sentToday: sentToday(), dailyLimit: DAILY_LIMIT,
    templates: db.prepare("SELECT * FROM templates ORDER BY name").all(),
    sequences: (db.prepare("SELECT * FROM sequences ORDER BY name").all() as Row[]).map((s) => ({ ...s, steps: JSON.parse(s.steps), active: !!s.active,
      counts: Object.fromEntries((db.prepare("SELECT status, COUNT(*) AS n FROM enrollments WHERE sequence_id = ? GROUP BY status").all(s.id) as Row[]).map((r) => [r.status, r.n])) })),
  }));
  for (const [kind, fields, table] of [["templates", templateFields, "templates"], ["sequences", sequenceFields, "sequences"]] as const) {
    app.post(`/api/${kind}`, async (c) => {
      try {
        const v = fields.parse(await c.req.json()) as Row, id = randomUUID();
        if (table === "templates") db.prepare("INSERT INTO templates (id, name, subject, body, created_at) VALUES (?, ?, ?, ?, ?)").run(id, v.name, v.subject, v.body, Date.now());
        else db.prepare("INSERT INTO sequences (id, name, steps, active, created_at) VALUES (?, ?, ?, ?, ?)").run(id, v.name, JSON.stringify(v.steps), Number(v.active), Date.now());
        return c.json({ id }, 201);
      } catch (e) { return c.json({ error: bad(e) }, 400); }
    });
    app.patch(`/api/${kind}/:id`, async (c) => {
      const cur = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(c.req.param("id")) as Row | undefined;
      if (!cur) return c.json({ error: "Introuvable" }, 404);
      try {
        const v = fields.parse({ ...cur, ...(table === "sequences" && { steps: JSON.parse(cur.steps), active: !!cur.active }), ...(await c.req.json()) }) as Row;
        if (table === "templates") db.prepare("UPDATE templates SET name = ?, subject = ?, body = ? WHERE id = ?").run(v.name, v.subject, v.body, cur.id);
        else db.prepare("UPDATE sequences SET name = ?, steps = ?, active = ? WHERE id = ?").run(v.name, JSON.stringify(v.steps), Number(v.active), cur.id);
        return c.json({ ok: true });
      } catch (e) { return c.json({ error: bad(e) }, 400); }
    });
    app.delete(`/api/${kind}/:id`, (c) => db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(c.req.param("id")).changes ? c.json({ ok: true }) : c.json({ error: "Introuvable" }, 404));
  }
  app.post("/api/contacts/:id/email", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const t = b.template_id ? db.prepare("SELECT * FROM templates WHERE id = ?").get(b.template_id) as Row | undefined : undefined;
    try { return c.json(await sendToContact(c.req.param("id"), b.subject ?? t?.subject ?? "", b.body ?? t?.body ?? "")); }
    catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });
  app.post("/api/contacts/:id/preview", async (c) => {
    const ct = getContact(c.req.param("id"));
    const b = await c.req.json().catch(() => ({}));
    return ct ? c.json({ subject: render(String(b.subject ?? ""), ct), body: render(String(b.body ?? ""), ct) }) : c.json({ error: "Contact introuvable" }, 404);
  });
  app.post("/api/contacts/:id/enroll", async (c) => {
    try { enroll(c.req.param("id"), (await c.req.json()).sequence_id); return c.json({ ok: true }); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });
  app.get("/api/contacts/:id/enrollments", (c) => c.json(db.prepare("SELECT e.*, s.name FROM enrollments e JOIN sequences s ON s.id = e.sequence_id WHERE contact_id = ?").all(c.req.param("id"))));

  setInterval(() => { if (mailReady()) void runSequences().catch((e) => console.error("[séquences]", e.message)); }, 30 * 60 * 1000).unref();
}
