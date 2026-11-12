// Agents IA : une clé par agent (Claude Code, Codex, OpenCode, Hermes…), journal de chacun de leurs appels MCP.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Hono } from "hono";
import type { McpServer } from "@modelcontextprotocol/server";
import { db } from "./db.ts";
import { migrate } from "./migrations.ts";
import { securityEvent } from "./security-events.ts";
import { isAdmin } from "./admin.ts";

type Row = Record<string, any>;
migrate("agents-1", `
  CREATE TABLE agent_keys (id TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, read_only INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, last_used INTEGER);
  CREATE TABLE agent_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, agent TEXT NOT NULL, tool TEXT NOT NULL, args TEXT, ok INTEGER NOT NULL, error TEXT);
  CREATE INDEX agent_log_ts ON agent_log(ts);
`);

// L1 : portée par projet. Les clés existantes migrent en « tous projets » (drapeau explicite).
export const SCOPES_MIGRATION = `ALTER TABLE agent_keys ADD COLUMN all_projects INTEGER NOT NULL DEFAULT 1;
CREATE TABLE agent_scopes (agent_id TEXT NOT NULL REFERENCES agent_keys(id) ON DELETE CASCADE, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, mode TEXT NOT NULL CHECK (mode IN ('read','write')), PRIMARY KEY (agent_id, project_id));`;
migrate("2026-11-11-agent-scopes", SCOPES_MIGRATION);

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Nouvelle clé : la valeur n'est rendue qu'une fois, seule son empreinte est gardée. */
export type AgentIdentity = { id: string; name: string; readOnly: boolean; allProjects: boolean };

export function createAgentKey(name: string, readOnly: boolean, projects: string[] = [], allProjects = false, modes: Record<string, "read" | "write"> = {}) {
  const clean = name.trim().slice(0, 60);
  if (!clean) throw new Error("Nom de l'agent vide");
  const key = `ck_${randomBytes(24).toString("base64url")}`;
  const id = randomUUID();
  db.prepare("INSERT INTO agent_keys (id, name, hash, read_only, all_projects, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, clean, sha(key), readOnly ? 1 : 0, allProjects ? 1 : 0, Date.now());
  for (const pid of projects) db.prepare("INSERT OR IGNORE INTO agent_scopes (agent_id, project_id, mode) VALUES (?, ?, ?)").run(id, pid, readOnly ? "read" : modes[pid] ?? "write");
  return { id, name: clean, read_only: readOnly, all_projects: allProjects, projects, key };
}

export function findAgent(bearer: string | undefined): AgentIdentity | null {
  if (!bearer?.startsWith("ck_")) return null;
  const r = db.prepare("SELECT id, name, read_only, all_projects FROM agent_keys WHERE hash = ?").get(sha(bearer)) as Row | undefined;
  if (!r) return null;
  db.prepare("UPDATE agent_keys SET last_used = ? WHERE id = ?").run(Date.now(), r.id);
  return { id: r.id, name: r.name, readOnly: !!r.read_only, allProjects: !!r.all_projects };
}

/** L1 : point d'autorisation unique. read n'autorise que la lecture ; write autorise les deux. */
export function canAccess(agent: AgentIdentity, projectId: string, mode: "read" | "write"): boolean {
  if (agent.allProjects) return true;
  const r = db.prepare("SELECT mode FROM agent_scopes WHERE agent_id = ? AND project_id = ?").get(agent.id, projectId) as { mode: string } | undefined;
  if (!r) return false;
  return mode === "read" || r.mode === "write";
}

/** L1 : projets visibles par une clé (null = tous). Sert aux agrégats REST et au MCP. */
export function visibleProjectIds(agent: AgentIdentity): Set<string> | null {
  if (agent.allProjects) return null;
  return new Set((db.prepare("SELECT project_id FROM agent_scopes WHERE agent_id = ?").all(agent.id) as { project_id: string }[]).map((r) => r.project_id));
}

/** L1 : projets où la clé peut écrire (null = tous). Toujours inclus dans visibleProjectIds. */
export function writableProjectIds(agent: AgentIdentity): Set<string> | null {
  if (agent.allProjects) return null;
  if (agent.readOnly) return new Set();
  return new Set((db.prepare("SELECT project_id FROM agent_scopes WHERE agent_id = ? AND mode = 'write'").all(agent.id) as { project_id: string }[]).map((r) => r.project_id));
}

/** Domaines des sites des projets visibles (null = tous). Filtre /api/overview et /api/sites. */
export function visibleDomains(agent: AgentIdentity): Set<string> | null {
  const ids = visibleProjectIds(agent);
  if (!ids) return null;
  const out = new Set<string>();
  const rows = db.prepare("SELECT id, sites FROM projects").all() as { id: string; sites: string }[];
  for (const r of rows) {
    if (!ids.has(r.id)) continue;
    try { for (const d of JSON.parse(r.sites) as string[]) out.add(d); } catch { /* ignoré */ }
  }
  return out;
}

/** Projet visé par une route REST, ou null pour un agrégat. */
export function projectForPath(path: string): string | null {
  let m = /^\/api\/projects\/([^/]+)/.exec(path);
  if (m) {
    const id = decodeURIComponent(m[1]);
    return (db.prepare("SELECT id FROM projects WHERE id = ?").get(id) as { id: string } | undefined)?.id
      ?? (db.prepare("SELECT id FROM projects WHERE crm_key = ?").get(id) as { id: string } | undefined)?.id ?? null;
  }
  m = /^\/api\/indicators\/([^/]+)/.exec(path);
  if (m) return (db.prepare("SELECT project_id AS p FROM indicators WHERE id = ?").get(m[1]) as { p: string } | undefined)?.p ?? null;
  m = /^\/api\/sites\/([^/]+)/.exec(path);
  if (m) {
    const s = db.prepare("SELECT domain FROM sites WHERE id = ?").get(m[1]) as { domain: string } | undefined;
    if (!s) return null;
    return (db.prepare("SELECT p.id FROM projects p, json_each(p.sites) j WHERE j.value = ?").get(s.domain) as { id: string } | undefined)?.id ?? null;
  }
  return null;
}

export function logCall(agent: string, tool: string, args: unknown, error?: string) {
  const text = args && Object.keys(args as object).length ? JSON.stringify(args).slice(0, 500) : null;
  db.prepare("INSERT INTO agent_log (ts, agent, tool, args, ok, error) VALUES (?, ?, ?, ?, ?, ?)").run(Date.now(), agent, tool, text, error ? 0 : 1, error?.slice(0, 300) ?? null);
  db.prepare("DELETE FROM agent_log WHERE id <= (SELECT MAX(id) - 5000 FROM agent_log)").run();
}

export const agentLog = (limit = 50, agent?: string) =>
  db.prepare(`SELECT ts, agent, tool, args, ok, error FROM agent_log ${agent ? "WHERE agent = ?" : ""} ORDER BY id DESC LIMIT ?`).all(...(agent ? [agent, limit] : [limit])) as Row[];

/** Chaque outil enregistré ensuite passe par le journal, avec le nom de l'agent qui l'appelle. */
export function instrument(server: McpServer, agent: string) {
  const register = server.registerTool.bind(server) as (...a: any[]) => any;
  (server as any).registerTool = (name: string, config: unknown, cb: (...a: any[]) => any) =>
    register(name, config, async (...a: any[]) => {
      try { const r = await cb(...a); logCall(agent, name, a.length > 1 ? a[0] : undefined); return r; }
      catch (e) { logCall(agent, name, a.length > 1 ? a[0] : undefined, (e as Error).message); throw e; }
    });
}

export function registerAgents(app: Hono) {
  // Créer ou révoquer une clé : réservé à la session administrateur dans l'interface, jamais à une clé API
  app.use("/api/agents", async (c, next) => c.req.method !== "GET" && c.req.header("authorization") ? c.json({ error: "Les clés d'agent se gèrent depuis l'interface" }, 403) : next());
  app.use("/api/agents/*", async (c, next) => c.req.method !== "GET" && c.req.header("authorization") ? c.json({ error: "Les clés d'agent se gèrent depuis l'interface" }, 403) : next());
  app.get("/api/agents", (c) => {
    const rows = db.prepare("SELECT id, name, read_only, all_projects, created_at, last_used FROM agent_keys ORDER BY created_at").all() as Row[];
    const scopes = db.prepare("SELECT s.agent_id, s.project_id, s.mode, p.name FROM agent_scopes s LEFT JOIN projects p ON p.id = s.project_id ORDER BY p.name").all() as Row[];
    return c.json(rows.map((k) => ({ ...k, scopes: scopes.filter((s) => s.agent_id === k.id).map((s) => ({ project_id: s.project_id, name: s.name ?? s.project_id, mode: s.mode })) })));
  });
  app.post("/api/agents", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const readOnly = b.read_only === undefined ? true : !!b.read_only;   // lecture seule par défaut (Nadir, tour 3)
    const all = b.all_projects === true;
    const scopes = Array.isArray(b.scopes) ? b.scopes as { project_id: string; mode: "read" | "write" }[] : [];
    if (!Array.isArray(b.projects) && !all && !scopes.length) return c.json({ error: "Choisissez une liste de projets ou all_projects: true" }, 400);
    const projects = scopes.length ? scopes.map((s) => String(s.project_id)) : Array.isArray(b.projects) ? b.projects.map(String) : [];
    const modes: Record<string, "read" | "write"> = {};
    for (const s of scopes) {
      if (!s || typeof s.project_id !== "string" || !["read", "write"].includes(s?.mode)) return c.json({ error: "project_id et mode (read|write) requis" }, 400);
      modes[s.project_id] = s.mode;
    }
    for (const pid of projects) if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(pid)) return c.json({ error: "Projet introuvable" }, 400);
    try { const k = createAgentKey(String(b.name ?? ""), readOnly, projects, all, modes); securityEvent("key_created", readOnly ? "lecture seule" : "complète"); return c.json(k, 201); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });
  app.delete("/api/agents/:id", (c) => {
    const r = db.prepare("DELETE FROM agent_keys WHERE id = ?").run(c.req.param("id"));
    if (r.changes) securityEvent("key_revoked", "agent");
    return r.changes ? c.json({ ok: true }) : c.json({ error: "Clé introuvable" }, 404);
  });
  // L1 : portée d'une clé, réservée à l'administrateur (jamais une clé).
  app.put("/api/agents/:id/scopes", async (c) => {
    if (!isAdmin(c)) return c.json({ error: "Réservé à l'administrateur" }, 403);
    const id = c.req.param("id");
    if (!db.prepare("SELECT 1 FROM agent_keys WHERE id = ?").get(id)) return c.json({ error: "Clé introuvable" }, 404);
    const b = await c.req.json().catch(() => ({}));
    const all = !!b.all_projects;
    const list = Array.isArray(b.projects) ? b.projects as { project_id: string; mode: "read" | "write" }[] : [];
    db.exec("BEGIN");
    try {
      db.prepare("UPDATE agent_keys SET all_projects = ? WHERE id = ?").run(all ? 1 : 0, id);
      db.prepare("DELETE FROM agent_scopes WHERE agent_id = ?").run(id);
      for (const s of list) {
        if (typeof s?.project_id !== "string" || !s.project_id || !["read", "write"].includes(s?.mode)) throw new Error("project_id et mode (read|write) requis");
        if (!["read", "write"].includes(s.mode)) throw new Error("Mode invalide");
        if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(s.project_id)) throw new Error("Projet introuvable");
        db.prepare("INSERT INTO agent_scopes (agent_id, project_id, mode) VALUES (?, ?, ?)").run(id, s.project_id, s.mode);
      }
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); return c.json({ error: (e as Error).message }, 400); }
    securityEvent("scope_changed", all ? "tous projets" : `${list.length} projet(s)`);
    return c.json({ ok: true, all_projects: all, projects: list });
  });
  app.get("/api/agents/log", (c) => c.json(agentLog(Math.min(Number(c.req.query("limit")) || 50, 500), c.req.query("agent") || undefined)));
}
