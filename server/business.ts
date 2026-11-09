// Module privé : CRM (prospects et clients), historique des échanges, calendrier des publications.
import type { Hono } from "hono";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { db, localDay } from "./db.ts";
import { migrate } from "./migrations.ts";

/** Le CRM contient des données de contacts : en démonstration (lecture ouverte à tous) il n'expose ni route ni outil MCP. */
export const crmEnabled = () => process.env.DEMO !== "1";

db.exec(`
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  company TEXT, email TEXT, phone TEXT, city TEXT, address TEXT, sector TEXT, site_url TEXT,
  project TEXT,                   -- ex. mon-produit-a, mon-produit-b
  source TEXT,                    -- ex. google_maps, site, recommandation
  stage TEXT NOT NULL DEFAULT 'new',
  value REAL,                     -- montant espéré ou signé (€)
  tags TEXT NOT NULL DEFAULT '[]',
  next_at TEXT,                   -- prochaine relance (AAAA-MM-JJ)
  next_action TEXT,
  opt_out INTEGER NOT NULL DEFAULT 0, -- a demandé à ne plus être contacté
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS contacts_stage ON contacts(stage);
CREATE INDEX IF NOT EXISTS contacts_next ON contacts(next_at);

CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,             -- note | stage | email | sms | call
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS activities_contact ON activities(contact_id, ts);

CREATE TABLE IF NOT EXISTS publications (
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL,              -- AAAA-MM-JJ
  title TEXT NOT NULL,
  project TEXT, network TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled', -- idea | scheduled | published
  url TEXT, notes TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS publications_day ON publications(day);
`);

// Code de campagne (utm_campaign) de chaque publication, pour compter les visites qu'elle amène
migrate("2026-11-09-campagnes", "ALTER TABLE publications ADD COLUMN campaign TEXT");

export const STAGES = ["new", "contacted", "qualified", "proposal", "won", "lost"] as const;
export const PUB_STATUS = ["idea", "scheduled", "published"] as const;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const today = () => localDay();

// Les textes trop longs sont tronqués plutôt que refusés (imports de fichiers hétérogènes)
const str = (max = 200) => z.string().nullish().transform((v) => v?.trim().slice(0, max) || null);
const contactFields = z.object({
  name: z.string().trim().regex(/[\p{L}\p{N}]{2}/u, "nom sans lettres").transform((v) => v.slice(0, 200)),
  company: str(), email: str(),
  // Un « téléphone » sans au moins 8 chiffres est un champ mal rempli (colonnes décalées dans un fichier)
  phone: str(50).transform((v) => v && v.replace(/\D/g, "").length >= 8 ? v : null), city: str(100), address: str(300), sector: str(100),
  site_url: str(300), project: str(50), source: str(100),
  stage: z.enum(STAGES).default("new"),
  value: z.number().finite().nullish().transform((v) => v ?? null),
  tags: z.array(z.string().transform((v) => v.trim().slice(0, 50))).transform((t) => t.filter(Boolean).slice(0, 30)).default([]),
  // Champ date vide du formulaire = pas de relance prévue
  next_at: z.string().nullish().transform((v) => v || null).pipe(z.string().regex(DAY).nullable()),
  next_action: str(300),
  opt_out: z.boolean().default(false),
});
const pubFields = z.object({
  day: z.string().regex(DAY),
  title: z.string().trim().min(1).max(300),
  project: str(50), network: str(50),
  status: z.enum(PUB_STATUS).default("scheduled"),
  url: str(500), notes: str(2000),
  campaign: z.string().trim().max(60).regex(/^[a-z0-9-]*$/, "lettres minuscules, chiffres et tirets").nullish().transform((v) => v || null),
});
const slug = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
export type ContactInput = z.input<typeof contactFields>;

type Row = Record<string, any>;
const decode = (c: Row | undefined): Row | undefined => c && { ...c, tags: JSON.parse(c.tags), opt_out: !!c.opt_out };
const cols = Object.keys(contactFields.shape);
const toDb = (v: Row) => cols.map((k) => k === "tags" ? JSON.stringify(v.tags) : k === "opt_out" ? Number(v.opt_out) : v[k]);

export function getContact(id: string): Row | undefined {
  const c = decode(db.prepare("SELECT * FROM contacts WHERE id = ?").get(id) as Row | undefined);
  return c && { ...c, activities: db.prepare("SELECT id, ts, kind, text FROM activities WHERE contact_id = ? ORDER BY ts DESC, id DESC").all(id) };
}

export function addActivity(contactId: string, kind: string, text: string) {
  db.prepare("INSERT INTO activities (contact_id, ts, kind, text) VALUES (?, ?, ?, ?)").run(contactId, Date.now(), kind, text.slice(0, 5000));
  db.prepare("UPDATE contacts SET updated_at = ? WHERE id = ?").run(Date.now(), contactId);
}

export function createContact(input: unknown) {
  const v = contactFields.parse(input);
  const id = randomUUID(), now = Date.now();
  db.prepare(`INSERT INTO contacts (id, ${cols.join(", ")}, created_at, updated_at) VALUES (?, ${cols.map(() => "?").join(", ")}, ?, ?)`)
    .run(id, ...toDb(v), now, now);
  return getContact(id)!;
}

export function updateContact(id: string, patch: unknown) {
  const cur = decode(db.prepare("SELECT * FROM contacts WHERE id = ?").get(id) as Row | undefined);
  if (!cur) return null;
  const v = contactFields.parse({ ...cur, ...(patch as Row) });
  db.prepare(`UPDATE contacts SET ${cols.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(...toDb(v), Date.now(), id);
  if (v.stage !== cur.stage) addActivity(id, "stage", `${cur.stage} → ${v.stage}`);
  if (v.opt_out && !cur.opt_out) addActivity(id, "note", "Ne souhaite plus être contacté");
  return getContact(id)!;
}

/** Liste filtrée et paginée. `todo` : relances prévues aujourd'hui ou en retard. */
export function listContacts(f: { q?: string; stage?: string; project?: string; source?: string; todo?: boolean; limit?: number; offset?: number }) {
  const where: string[] = [], args: (string | number)[] = [];
  if (f.q) {
    where.push("(name LIKE ? OR company LIKE ? OR email LIKE ? OR phone LIKE ? OR city LIKE ? OR sector LIKE ?)");
    args.push(...Array(6).fill(`%${f.q}%`));
  }
  for (const k of ["stage", "project", "source"] as const) if (f[k]) { where.push(`${k} = ?`); args.push(f[k]!); }
  if (f.todo) { where.push("next_at <= ? AND opt_out = 0 AND stage NOT IN ('won', 'lost')"); args.push(today()); }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 500), offset = Math.max(f.offset ?? 0, 0);
  const order = f.todo ? "next_at, updated_at DESC" : "updated_at DESC";
  return {
    total: (db.prepare(`SELECT COUNT(*) AS n FROM contacts ${w}`).get(...args) as { n: number }).n,
    rows: (db.prepare(`SELECT * FROM contacts ${w} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`).all(...args) as Row[]).map(decode),
  };
}

const norm = (s?: string | null) => (s ?? "").toLowerCase().replace(/[^a-z0-9@]/g, "");
/** Import en masse : doublon si même téléphone, même email, ou même nom dans la même ville. */
export function importContacts(items: unknown[], defaults: Row = {}) {
  const seen = new Set<string>();
  for (const c of db.prepare("SELECT name, phone, email, city FROM contacts").all() as Row[]) {
    if (c.phone) seen.add("p" + norm(c.phone));
    if (c.email) seen.add("e" + norm(c.email));
    seen.add("n" + norm(c.name) + "|" + norm(c.city));
  }
  let added = 0, skipped = 0, invalid = 0;
  db.exec("BEGIN");
  try {
    for (const raw of items) {
      const r = contactFields.safeParse({ ...defaults, ...(raw as Row) });
      if (!r.success) { invalid++; continue; }
      const keys = [r.data.phone && "p" + norm(r.data.phone), r.data.email && "e" + norm(r.data.email), "n" + norm(r.data.name) + "|" + norm(r.data.city)].filter(Boolean) as string[];
      if (keys.some((k) => seen.has(k))) { skipped++; continue; }
      keys.forEach((k) => seen.add(k));
      const id = randomUUID(), now = Date.now();
      db.prepare(`INSERT INTO contacts (id, ${cols.join(", ")}, created_at, updated_at) VALUES (?, ${cols.map(() => "?").join(", ")}, ?, ?)`).run(id, ...toDb(r.data), now, now);
      added++;
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return { added, skipped, invalid };
}

export function listPublications(f: { from?: string; to?: string; project?: string }) {
  const where = ["day BETWEEN ? AND ?"], args = [f.from ?? "0000-01-01", f.to ?? "9999-12-31"];
  if (f.project) { where.push("project = ?"); args.push(f.project); }
  // Visites amenées : pages vues portant le code de campagne de la publication
  return db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM events e WHERE e.utm_campaign = p.campaign AND e.type = 'pageview') AS visits
    FROM publications p WHERE ${where.join(" AND ")} ORDER BY day, created_at`).all(...args);
}
export function savePublication(id: string | null, input: unknown) {
  const cur = id ? db.prepare("SELECT * FROM publications WHERE id = ?").get(id) as Row | undefined : undefined;
  if (id && !cur) return null;
  const v = pubFields.parse({ ...cur, ...(input as Row) });
  const pid = id ?? randomUUID();
  const campaign = v.campaign ?? cur?.campaign ?? `${slug(v.title)}-${v.day.slice(5).replace("-", "")}`;
  db.prepare(`INSERT INTO publications (id, day, title, project, network, status, url, notes, campaign, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET day = excluded.day, title = excluded.title, project = excluded.project, network = excluded.network,
    status = excluded.status, url = excluded.url, notes = excluded.notes, campaign = excluded.campaign`)
    .run(pid, v.day, v.title, v.project, v.network, v.status, v.url, v.notes, campaign, cur?.created_at ?? Date.now());
  return db.prepare("SELECT * FROM publications WHERE id = ?").get(pid);
}

/** Résumé pour la vue d'ensemble. */
export function businessSummary() {
  const d = today();
  const monday = new Date(); monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const week = monday.toISOString().slice(0, 10);
  const sunday = new Date(monday.getTime() + 6 * 86400000).toISOString().slice(0, 10);
  const one = (sql: string, ...a: (string | number)[]) => Object.values(db.prepare(sql).get(...a) as Row)[0] ?? 0;
  return {
    stages: Object.fromEntries((db.prepare("SELECT stage, COUNT(*) AS n FROM contacts GROUP BY stage").all() as Row[]).map((r) => [r.stage, r.n])),
    projects: db.prepare("SELECT COALESCE(project, '') AS project, COUNT(*) AS n FROM contacts GROUP BY 1 ORDER BY n DESC").all(),
    sources: db.prepare("SELECT COALESCE(source, '') AS source, COUNT(*) AS n FROM contacts GROUP BY 1 ORDER BY n DESC").all(),
    todo: one("SELECT COUNT(*) FROM contacts WHERE next_at <= ? AND opt_out = 0 AND stage NOT IN ('won', 'lost')", d),
    pipelineValue: one("SELECT COALESCE(SUM(value), 0) FROM contacts WHERE stage IN ('qualified', 'proposal')"),
    wonMonth: one("SELECT COALESCE(SUM(value), 0) FROM contacts c WHERE stage = 'won' AND EXISTS (SELECT 1 FROM activities a WHERE a.contact_id = c.id AND a.kind = 'stage' AND a.text LIKE '%→ won' AND a.ts >= ?)", Date.parse(d.slice(0, 8) + "01")),
    touchesWeek: one("SELECT COUNT(*) FROM activities WHERE kind IN ('email', 'sms', 'call') AND ts >= ?", Date.parse(week)),
    pubsWeek: db.prepare("SELECT * FROM publications WHERE day BETWEEN ? AND ? ORDER BY day").all(week, sunday),
  };
}

/** Doublons probables d'un contact : même téléphone (9 derniers chiffres), même e-mail, ou même nom. */
export function duplicatesOf(id: string) {
  const c = getContact(id);
  if (!c) return [];
  const tail = (c.phone ?? "").replace(/\D/g, "").slice(-9);
  return (db.prepare(`SELECT * FROM contacts WHERE id <> ? AND ((? <> '' AND replace(replace(replace(phone, ' ', ''), '.', ''), '-', '') LIKE '%' || ?)
    OR (? <> '' AND lower(email) = lower(?)) OR lower(name) = lower(?)) LIMIT 10`).all(id, tail, tail, c.email ?? "", c.email ?? "", c.name) as Row[]).map(decode);
}

/** Fusionne `otherId` dans `keepId` : champs vides complétés, étiquettes réunies, historique déplacé, doublon supprimé. */
export function mergeContacts(keepId: string, otherId: string) {
  const keep = getContact(keepId), other = getContact(otherId);
  if (!keep || !other || keepId === otherId) throw new Error("Contacts introuvables");
  const patch: Row = { tags: [...new Set([...keep.tags, ...other.tags])], opt_out: keep.opt_out || other.opt_out };
  for (const k of cols) if (keep[k] == null && other[k] != null && k !== "tags") patch[k] = other[k];
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE activities SET contact_id = ? WHERE contact_id = ?").run(keepId, otherId);
    db.prepare("DELETE FROM contacts WHERE id = ?").run(otherId);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  updateContact(keepId, patch);
  addActivity(keepId, "note", `Fusionné avec le doublon « ${other.company || other.name} »`);
  return getContact(keepId)!;
}

/** Demande arrivée par un formulaire de site : nouveau contact, ou note sur le contact existant (même e-mail ou téléphone). */
export function inboundLead(input: Row) {
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const phoneDigits = typeof input.phone === "string" ? input.phone.replace(/\D/g, "") : "";
  const existing = (db.prepare("SELECT id, phone FROM contacts WHERE (? <> '' AND lower(email) = ?) OR (? <> '' AND replace(replace(replace(phone, ' ', ''), '.', ''), '-', '') LIKE '%' || ?)")
    .get(email, email, phoneDigits.slice(-9), phoneDigits.slice(-9)) as Row | undefined);
  const note = [`Formulaire « ${String(input.form ?? "site").slice(0, 60)} »`, input.message ? String(input.message).slice(0, 3000) : ""].filter(Boolean).join(" : ");
  if (existing) { addActivity(existing.id, "note", note); return { id: existing.id, created: false }; }
  const c = createContact({ name: input.name, company: input.company, email: email || null, phone: input.phone, sector: input.sector,
    project: input.project, source: input.source ?? "formulaire", stage: "new", next_at: localDay(), next_action: "Répondre à la demande" });
  addActivity(c.id, "note", note);
  return { id: c.id, created: true };
}

export function registerBusiness(app: Hono) {
  if (!crmEnabled()) return;
  // Formulaires des sites → CRM, avec une clé dédiée qui ne permet que cela (hors de /api, donc hors de l'authentification admin)
  const INBOUND_KEY = process.env.INBOUND_KEY ?? "";
  app.post("/inbound/lead", async (c) => {
    const bearer = c.req.header("authorization")?.replace(/^Bearer /, "") ?? "";
    if (!INBOUND_KEY || bearer.length !== INBOUND_KEY.length || !timingSafeEqual(Buffer.from(bearer), Buffer.from(INBOUND_KEY))) return c.json({ error: "Non autorisé" }, 401);
    try { return c.json(inboundLead(await c.req.json()), 201); } catch (e) { return c.json({ error: bad(e) }, 400); }
  });

  const bad = (e: unknown) => e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")} : ${i.message}`).join(", ") : (e as Error).message;

  app.get("/api/business", (c) => c.json(businessSummary()));

  app.get("/api/contacts", (c) => {
    const q = c.req.query();
    return c.json(listContacts({ ...q, todo: q.todo === "1", limit: Number(q.limit) || 50, offset: Number(q.offset) || 0 }));
  });
  app.get("/api/contacts/:id", (c) => { const x = getContact(c.req.param("id")); return x ? c.json(x) : c.json({ error: "Contact introuvable" }, 404); });
  app.post("/api/contacts", async (c) => {
    try { return c.json(createContact(await c.req.json()), 201); } catch (e) { return c.json({ error: bad(e) }, 400); }
  });
  app.patch("/api/contacts/:id", async (c) => {
    try { const x = updateContact(c.req.param("id"), await c.req.json()); return x ? c.json(x) : c.json({ error: "Contact introuvable" }, 404); }
    catch (e) { return c.json({ error: bad(e) }, 400); }
  });
  app.get("/api/contacts/:id/duplicates", (c) => c.json(duplicatesOf(c.req.param("id"))));
  app.post("/api/contacts/:id/merge", async (c) => {
    try { return c.json(mergeContacts(c.req.param("id"), (await c.req.json()).other_id)); } catch (e) { return c.json({ error: bad(e) }, 400); }
  });
  app.delete("/api/contacts/:id", (c) => db.prepare("DELETE FROM contacts WHERE id = ?").run(c.req.param("id")).changes ? c.json({ ok: true }) : c.json({ error: "Contact introuvable" }, 404));
  app.post("/api/contacts/:id/activities", async (c) => {
    const id = c.req.param("id");
    if (!getContact(id)) return c.json({ error: "Contact introuvable" }, 404);
    const b = await c.req.json().catch(() => ({}));
    const kind = ["note", "email", "sms", "call"].includes(b.kind) ? b.kind : "note";
    if (typeof b.text !== "string" || !b.text.trim()) return c.json({ error: "Texte vide" }, 400);
    addActivity(id, kind, b.text.trim());
    return c.json(getContact(id));
  });
  app.post("/api/contacts/import", async (c) => {
    const b = await c.req.json().catch(() => null);
    const items = Array.isArray(b) ? b : b?.items;
    if (!Array.isArray(items) || items.length > 20000) return c.json({ error: "Envoyez une liste de 20 000 contacts au plus" }, 400);
    return c.json(importContacts(items, b?.defaults ?? {}));
  });

  app.get("/api/publications", (c) => c.json(listPublications(c.req.query())));
  app.post("/api/publications", async (c) => {
    try { return c.json(savePublication(null, await c.req.json()), 201); } catch (e) { return c.json({ error: bad(e) }, 400); }
  });
  app.patch("/api/publications/:id", async (c) => {
    try { const p = savePublication(c.req.param("id"), await c.req.json()); return p ? c.json(p) : c.json({ error: "Publication introuvable" }, 404); }
    catch (e) { return c.json({ error: bad(e) }, 400); }
  });
  app.delete("/api/publications/:id", (c) => db.prepare("DELETE FROM publications WHERE id = ?").run(c.req.param("id")).changes ? c.json({ ok: true }) : c.json({ error: "Publication introuvable" }, 404));
}

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

export function registerBusinessTools(server: McpServer, readOnly = false) {
  if (!crmEnabled()) return;
  server.registerTool("crm_summary", { description: "Résumé CRM : contacts par étape, relances dues, valeur du pipeline, publications de la semaine." },
    async () => json(businessSummary()));
  server.registerTool("crm_list_contacts", {
    description: "Liste les contacts (prospects et clients). Filtres : recherche texte, étape (new, contacted, qualified, proposal, won, lost), projet, source, relances dues.",
    inputSchema: z.object({ q: z.string().optional(), stage: z.enum(STAGES).optional(), project: z.string().optional(), source: z.string().optional(), todo: z.boolean().optional(), limit: z.number().int().min(1).max(200).default(50) }),
  }, async (f) => json(listContacts(f)));
  server.registerTool("crm_get_contact", { description: "Fiche complète d'un contact avec son historique.", inputSchema: z.object({ id: z.string() }) },
    async ({ id }) => json(getContact(id) ?? { error: "Contact introuvable" }));
  if (!readOnly) server.registerTool("crm_save_contact", {
    description: "Crée un contact (sans id) ou modifie les champs d'un contact existant (avec id) : étape, relance (next_at AAAA-MM-JJ, next_action), valeur, tags, opt_out…",
    inputSchema: z.object({ id: z.string().optional(), fields: z.record(z.string(), z.unknown()) }),
  }, async ({ id, fields }) => json(id ? updateContact(id, fields) ?? { error: "Contact introuvable" } : createContact(fields)));
  if (!readOnly) server.registerTool("crm_log", {
    description: "Ajoute une entrée à l'historique d'un contact : note, email, sms ou call.",
    inputSchema: z.object({ id: z.string(), kind: z.enum(["note", "email", "sms", "call"]), text: z.string().min(1) }),
  }, async ({ id, kind, text }) => { if (!getContact(id)) return json({ error: "Contact introuvable" }); addActivity(id, kind, text); return json(getContact(id)); });
  server.registerTool("pubs_list", {
    description: "Publications planifiées ou publiées entre deux dates (AAAA-MM-JJ), filtrables par projet.",
    inputSchema: z.object({ from: z.string().optional(), to: z.string().optional(), project: z.string().optional() }),
  }, async (f) => json(listPublications(f)));
  if (!readOnly) server.registerTool("pubs_save", {
    description: "Crée (sans id) ou modifie (avec id) une publication : day AAAA-MM-JJ, title, project, network (tiktok, instagram, linkedin…), status (idea, scheduled, published), url, notes.",
    inputSchema: z.object({ id: z.string().optional(), fields: z.record(z.string(), z.unknown()) }),
  }, async ({ id, fields }) => json(savePublication(id ?? null, fields) ?? { error: "Publication introuvable" }));
}
