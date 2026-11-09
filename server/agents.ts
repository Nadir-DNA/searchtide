// Agents IA : une clé par agent (Claude Code, Codex, OpenCode, Hermes…), journal de chacun de leurs appels MCP.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Hono } from "hono";
import type { McpServer } from "@modelcontextprotocol/server";
import { db } from "./db.ts";
import { migrate } from "./migrations.ts";

type Row = Record<string, any>;
migrate("agents-1", `
  CREATE TABLE agent_keys (id TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, read_only INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_used INTEGER);
  CREATE TABLE agent_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, agent TEXT NOT NULL, tool TEXT NOT NULL, args TEXT, ok INTEGER NOT NULL, error TEXT);
  CREATE INDEX agent_log_ts ON agent_log(ts);
`);

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Nouvelle clé : la valeur n'est rendue qu'une fois, seule son empreinte est gardée. */
export function createAgentKey(name: string, readOnly: boolean) {
  const clean = name.trim().slice(0, 60);
  if (!clean) throw new Error("Nom de l'agent vide");
  const key = `ck_${randomBytes(24).toString("base64url")}`;
  const id = randomUUID();
  db.prepare("INSERT INTO agent_keys (id, name, hash, read_only, created_at) VALUES (?, ?, ?, ?, ?)").run(id, clean, sha(key), readOnly ? 1 : 0, Date.now());
  return { id, name: clean, read_only: readOnly, key };
}

export function findAgent(bearer: string | undefined): { name: string; readOnly: boolean } | null {
  if (!bearer?.startsWith("ck_")) return null;
  const r = db.prepare("SELECT id, name, read_only FROM agent_keys WHERE hash = ?").get(sha(bearer)) as Row | undefined;
  if (!r) return null;
  db.prepare("UPDATE agent_keys SET last_used = ? WHERE id = ?").run(Date.now(), r.id);
  return { name: r.name, readOnly: !!r.read_only };
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
  app.get("/api/agents", (c) => c.json(db.prepare("SELECT id, name, read_only, created_at, last_used FROM agent_keys ORDER BY created_at").all()));
  app.post("/api/agents", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    try { return c.json(createAgentKey(String(b.name ?? ""), !!b.read_only), 201); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });
  app.delete("/api/agents/:id", (c) => db.prepare("DELETE FROM agent_keys WHERE id = ?").run(c.req.param("id")).changes ? c.json({ ok: true }) : c.json({ error: "Clé introuvable" }, 404));
  app.get("/api/agents/log", (c) => c.json(agentLog(Math.min(Number(c.req.query("limit")) || 50, 500), c.req.query("agent") || undefined)));
}
