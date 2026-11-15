// Équipe (plan A10) : des comptes nominatifs en plus du mot de passe propriétaire (ADMIN_PASSWORD, qui garde tous les droits).
// Deux rôles : « admin » (mêmes droits que le propriétaire) et « membre » (lecture seule : tableaux de bord, projets, sites,
// À traiter). Le mot de passe est créé par Searchtide et affiché une seule fois ; il est stocké haché (scrypt).
import type { Hono } from "hono";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { db } from "./db.ts";
import { migrate } from "./migrations.ts";
import { isAdmin } from "./admin.ts";
import { securityEvent } from "./security-events.ts";

type Row = Record<string, any>;
export type Role = "admin" | "membre";
export type Member = { id: string; email: string; name: string; role: Role; epoch: number };

migrate("2026-11-17-equipe", `CREATE TABLE team_members (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role TEXT NOT NULL,
  pass_hash TEXT NOT NULL, epoch INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_login INTEGER)`);

const hash = (password: string, salt = randomBytes(16).toString("hex")) => `${salt}:${scryptSync(password, salt, 32).toString("hex")}`;
const verify = (password: string, stored: string) => {
  const [salt, h] = stored.split(":");
  if (!salt || !h) return false;
  const a = Buffer.from(scryptSync(password, salt, 32).toString("hex")), b = Buffer.from(h);
  return a.length === b.length && timingSafeEqual(a, b);
};
/** Mot de passe lisible de 20 caractères (sans 0/O ni 1/l), donné une fois à la personne. */
const newPassword = () => { const abc = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"; return Array.from(randomBytes(20), (b) => abc[b % abc.length]).join("").replace(/(.{5})(?!$)/g, "$1-"); };
const ROLES: Role[] = ["admin", "membre"];
const pub = (r: Row) => ({ id: r.id, email: r.email, name: r.name, role: r.role, created_at: r.created_at, last_login: r.last_login });

export const listMembers = () => (db.prepare("SELECT * FROM team_members ORDER BY created_at").all() as Row[]).map(pub);

export function createMember(input: { email?: unknown; name?: unknown; role?: unknown }) {
  const email = String(input.email ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Adresse e-mail invalide");
  const name = String(input.name ?? "").trim().slice(0, 80) || email.split("@")[0];
  const role = ROLES.includes(input.role as Role) ? input.role as Role : "membre";
  if (db.prepare("SELECT 1 FROM team_members WHERE email = ?").get(email)) throw new Error("Cette adresse a déjà un compte");
  const password = newPassword(), id = randomUUID();
  db.prepare("INSERT INTO team_members (id, email, name, role, pass_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, email, name, role, hash(password), Date.now());
  securityEvent("team_member_created", `compte d'équipe créé (${role})`);
  return { ...pub(db.prepare("SELECT * FROM team_members WHERE id = ?").get(id) as Row), password };
}

export function updateMember(id: string, input: { role?: unknown; name?: unknown; resetPassword?: unknown }) {
  const m = db.prepare("SELECT * FROM team_members WHERE id = ?").get(id) as Row | undefined;
  if (!m) throw new Error("Compte introuvable");
  const role = input.role !== undefined ? (ROLES.includes(input.role as Role) ? input.role : (() => { throw new Error("Rôle inconnu"); })()) : m.role;
  const name = input.name !== undefined ? String(input.name).trim().slice(0, 80) || m.name : m.name;
  let password: string | undefined;
  if (input.resetPassword) password = newPassword();
  // Changer le rôle ou le mot de passe déconnecte la personne partout.
  const bump = role !== m.role || !!password;
  db.prepare("UPDATE team_members SET role = ?, name = ?, pass_hash = ?, epoch = epoch + ? WHERE id = ?").run(role, name, password ? hash(password) : m.pass_hash, bump ? 1 : 0, id);
  if (bump) securityEvent("team_member_updated", `compte d'équipe modifié (${role}${password ? ", nouveau mot de passe" : ""})`);
  return { ...pub(db.prepare("SELECT * FROM team_members WHERE id = ?").get(id) as Row), ...(password ? { password } : {}) };
}

export function deleteMember(id: string) {
  const n = db.prepare("DELETE FROM team_members WHERE id = ?").run(id).changes;
  if (n) securityEvent("team_member_deleted", "compte d'équipe supprimé");
  return n > 0;
}

/** Connexion d'un membre : renvoie la valeur du cookie, ou null (même réponse pour adresse inconnue et mot de passe faux). */
export function loginMember(email: string, password: string): string | null {
  const m = db.prepare("SELECT * FROM team_members WHERE email = ?").get(String(email ?? "").trim().toLowerCase()) as Row | undefined;
  const ok = m ? verify(String(password ?? ""), m.pass_hash) : (verify(String(password ?? ""), hash("leurre")), false);
  if (!m || !ok) return null;
  db.prepare("UPDATE team_members SET last_login = ? WHERE id = ?").run(Date.now(), m.id);
  return `member.${m.id}.${m.epoch}`;
}

/** Cookie de membre valide (même époque) → le membre ; sinon null. */
export function memberFromCookie(value: string | false | undefined): Member | null {
  if (!value) return null;
  const [kind, id, epoch] = value.split(".");
  if (kind !== "member" || !id) return null;
  const m = db.prepare("SELECT id, email, name, role, epoch FROM team_members WHERE id = ?").get(id) as Member | undefined;
  return m && Number(epoch) === m.epoch ? m : null;
}
export const logoutMember = (id: string) => { db.prepare("UPDATE team_members SET epoch = epoch + 1 WHERE id = ?").run(id); };

export function registerTeam(app: Hono) {
  const admin = (c: any) => isAdmin(c) ? null : c.json({ error: "Réservé à l'administrateur" }, 403);
  app.get("/api/team", (c) => admin(c) ?? c.json(listMembers()));
  app.post("/api/team", async (c) => {
    const d = admin(c); if (d) return d;
    if (process.env.DEMO === "1") return c.json({ error: "Désactivé en démonstration." }, 403);
    try { return c.json(createMember(await c.req.json().catch(() => ({}))), 201); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });
  app.patch("/api/team/:id", async (c) => {
    const d = admin(c); if (d) return d;
    try { return c.json(updateMember(c.req.param("id"), await c.req.json().catch(() => ({})))); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });
  app.delete("/api/team/:id", (c) => admin(c) ?? (deleteMember(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "Compte introuvable" }, 404)));
}
