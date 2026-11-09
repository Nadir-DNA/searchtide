// Qui est administrateur ? Seulement une session ouverte par mot de passe (cookie signé).
// Les clés d'API et les clés d'agent (MCP) ne le sont jamais : elles ne créent, modifient ni retirent de connexion (D8, R11).
import type { Context } from "hono";

const admins = new WeakSet<Request>();
export const markAdmin = (c: Context) => { admins.add(c.req.raw); };
export const isAdmin = (c: Context) => admins.has(c.req.raw);
