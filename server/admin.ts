// Qui est administrateur ? Seulement une session ouverte par mot de passe (cookie signé).
// Les clés d'API et les clés d'agent (MCP) ne le sont jamais : elles ne créent, modifient ni retirent de connexion (D8, R11).
import type { Context } from "hono";

const admins = new WeakSet<Request>();
export const markAdmin = (c: Context) => { admins.add(c.req.raw); };
export const isAdmin = (c: Context) => admins.has(c.req.raw);

// Clés d'API, clé en lecture seule et clés d'agent : elles lisent la liste des connexions, jamais les réglages (R11).
const clients = new WeakSet<Request>();
export const markClient = (c: Context) => { clients.add(c.req.raw); };
export type Viewer = "admin" | "client" | "anon";
/** admin : session par mot de passe · client : clé d'API ou d'agent · anon : lecture ouverte de la démonstration, sans identifiant. */
export const viewerOf = (c: Context): Viewer => (admins.has(c.req.raw) ? "admin" : clients.has(c.req.raw) ? "client" : "anon");
