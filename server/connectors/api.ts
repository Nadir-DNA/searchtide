// API des connecteurs et des connexions. Lecture : toute session ou clé d'API. Écriture : administrateur seulement (D8, R11).
// Aucune réponse ne contient de secret (R3) ; toute erreur est nettoyée des secrets connus avant d'être renvoyée ou journalisée (R4).
import type { Context, Hono } from "hono";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { isAdmin, viewerOf, type Viewer } from "../admin.ts";
import { connections, createConnection, findByFingerprint, getConnection, getSecrets, markStatus, removeConnection, setSecrets } from "../connections.ts";
import { db } from "../db.ts";
import { SECRET_MESSAGE, VaultError, fingerprint, scrub, secretValid, secretValues } from "../vault.ts";
import { all, get, publicManifest, realCtx, runTest } from "./registry.ts";
import type { Cfg, Connector, Ctx, Field, TestResult } from "./types.ts";
import "./index.ts"; // enregistre les connecteurs

type Row = Record<string, any>;

let ctxOverride: Ctx | undefined;
/** Pour les tests : remplace l'accès réseau de tous les connecteurs. Sans argument, revient au réseau réel. */
export function setConnectorContext(ctx?: Ctx) { ctxOverride = ctx; }
const ctx = () => ctxOverride ?? realCtx();

const DEMO = () => process.env.DEMO === "1";
const LATER = ["Cloudflare", "Gmail (lecture)", "Sauvegarde distante", "CRM tiers", "Connexion en un clic"];
const RANK: Record<string, number> = { reconnect: 3, error: 2, connected: 1 };

const forbidden = (c: Context) => c.json({ error: "Réservé à l'administrateur : connectez-vous avec le mot de passe de l'instance." }, 403);

/**
 * Vue d'une connexion, selon qui regarde (R11) :
 *  - administrateur (session) : tout sauf les secrets — indice, réglages non secrets (hôte, identifiant, domaine, bucket…), détail du statut ;
 *  - client (clé d'API, agent MCP) : id, type, libellé, indice, statut — ni réglages ni détail ;
 *  - anonyme (lecture ouverte de la démonstration) : rien (la liste est vide).
 */
function view(r: Row, who: Viewer = "client") {
  const base = { id: r.id, kind: r.kind, label: r.label, status: r.status, tested_at: r.tested_at, livemode: !!r.livemode, test_mode: r.config?.test === true, created_at: r.created_at };
  if (who === "client") return { ...base, hint: r.config?.hint ?? "", status_detail: null };
  return { ...base, hint: r.config?.hint ?? "", status_detail: r.status_detail,
    // Réglages non secrets pour préremplir « Remplacer la clé » ; les secrets n'y sont jamais.
    settings: Object.fromEntries(Object.entries(r.config ?? {}).filter(([k]) => k !== "hint" && k !== "test")) };
}
/** Liste pour les clients non administrateurs (outil MCP `connections_list`, clés d'API). */
export const listForClients = () => connections().map((r) => view(r, "client"));
const listFor = (who: Viewer) => (who === "anon" ? [] : connections().map((r) => view(r, who)));

function worst(rows: Row[]): string {
  return rows.reduce((w, r) => (RANK[r.status] > RANK[w] ? r.status : w), "connected");
}

/** Sépare les valeurs reçues en réglages (config) et secrets, selon le manifeste. Renvoie une erreur lisible si un champ requis manque. */
function split(c: Connector, values: Record<string, unknown>, keep?: { config: Row; secrets: Row }): { cfg: Cfg } | { error: string } {
  const config: Row = { ...(keep?.config ?? {}) }, secrets: Row = { ...(keep?.secrets ?? {}) };
  for (const f of c.fields) {
    const raw = values[f.key];
    if (raw === undefined && keep) continue; // champ non envoyé : on garde la valeur actuelle
    let v = typeof raw === "string" ? raw.trim() : raw == null ? "" : String(raw);
    if (!v && keep && f.secret) continue; // « laisser vide pour garder la clé actuelle »
    if (!v && f.default !== undefined) v = f.default;
    if (!v) { if (f.required && !(keep && (f.secret ? keep.secrets[f.key] : keep.config[f.key]))) return { error: `Champ requis : ${f.label}` }; if (!f.secret) delete config[f.key]; continue; }
    if (f.type === "json") { try { const j = JSON.parse(v); if (!j || typeof j !== "object") throw 0; v = JSON.stringify(j); } catch { return { error: `${f.label} : ce n'est pas un JSON valide.` }; } }
    if (f.type === "number" && !Number.isFinite(Number(v))) return { error: `${f.label} : nombre attendu.` };
    if (f.type === "select" && !f.options?.some((o) => o.value === v)) return { error: `${f.label} : choix inconnu.` };
    if (f.secret) secrets[f.key] = v; else config[f.key] = f.type === "number" ? Number(v) : v;
  }
  return { cfg: { config, secrets } };
}

/** Secret principal d'un connecteur : le premier champ secret, pour l'empreinte anti-doublon (R10). */
const primary = (c: Connector, secrets: Row) => { const f = c.fields.find((x: Field) => x.secret); return f ? String(secrets[f.key] ?? "") : ""; };

const logSafe = (cfg: Cfg | undefined, e: unknown) => console.error("[connexions]", scrub(e instanceof Error ? e.message : String(e), secretValues(cfg?.secrets)));

const statusOf = (r: TestResult): "connected" | "error" | "reconnect" =>
  r.ok ? "connected" : r.failure === "auth" || r.failure === "permission" ? "reconnect" : "error";

export function registerConnections(app: Hono) {
  // Catalogue : manifestes + connexions de chacun. Aucune fonction, aucun secret.
  app.get("/api/connectors", (c) => {
    const who = viewerOf(c);
    const rows = who === "anon" ? [] : connections();
    return c.json({
      vault: { ok: secretValid(), message: secretValid() ? null : SECRET_MESSAGE },
      demo: DEMO(),
      admin: isAdmin(c),
      connectors: all().map((m) => {
        const mine = rows.filter((r) => r.kind === m.id);
        return { ...publicManifest(m), connections: mine.map((r) => view(r, who)), status: mine.length ? worst(mine) : m.builtin ? "builtin" : "none" };
      }),
      later: LATER,
    });
  });

  app.get("/api/connections", (c) => c.json({ vault: secretValid(), list: listFor(viewerOf(c)) }));

  app.post("/api/connections", async (c) => {
    if (!isAdmin(c)) return forbidden(c);
    if (DEMO()) return c.json({ error: "Désactivé en démonstration." }, 403);
    const b = await c.req.json().catch(() => ({})) as Row;
    const m = get(String(b.kind ?? ""));
    if (!m || m.builtin) return c.json({ error: "Connecteur inconnu" }, 400);
    if (!secretValid()) return c.json({ error: SECRET_MESSAGE }, 400); // R2, CA8
    if (m.singleton && connections(m.id).length) return c.json({ error: `${m.name} est déjà connecté : modifiez la connexion existante.` }, 409);
    const parsed = split(m, b.values ?? {});
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    const { cfg } = parsed;
    const main = primary(m, cfg.secrets);
    if (main) {
      const dup = findByFingerprint(m.id, main);
      if (dup) return c.json({ error: `Cette clé est déjà enregistrée sous « ${dup.label} ».` }, 409); // R10, CA13
    }
    let result: TestResult;
    try { result = await runTest(m, cfg, ctx()); } catch (e) { logSafe(cfg, e); return c.json({ error: "Le test a échoué." }, 400); }
    if (!result.ok) { logSafe(cfg, new Error(`${m.id} : ${result.error}`)); return c.json({ error: result.error ?? "Test échoué", failure: result.failure }, 400); } // R5, CA11 : rien n'est écrit
    try {
      const label = String(b.label ?? "").trim().slice(0, 80) || result.label || m.name;
      const conn = createConnection({ kind: m.id, label, account: result.account, livemode: result.livemode,
        config: { ...cfg.config, ...(result.settings ?? {}), hint: m.hint(cfg), ...(result.livemode === false ? { test: true } : {}) }, secrets: cfg.secrets, fingerprintOf: main || undefined });
      markStatus(conn.id, "connected", null);
      return c.json({ connection: view(getConnection(conn.id)!, "admin"), test: { label: result.label, detail: result.detail, warnings: result.warnings ?? [] } }, 201);
    } catch (e) {
      if (e instanceof VaultError) return c.json({ error: e.message }, 400);
      logSafe(cfg, e); return c.json({ error: "Enregistrement impossible." }, 500);
    }
  });

  // Remplacer la clé ou renommer : l'id est conservé, les indicateurs liés ne bougent pas (P5, CA18)
  app.patch("/api/connections/:id", async (c) => {
    if (!isAdmin(c)) return forbidden(c);
    if (DEMO()) return c.json({ error: "Désactivé en démonstration." }, 403);
    const conn = getConnection(c.req.param("id"));
    if (!conn) return c.json({ error: "Connexion introuvable" }, 404);
    const m = get(conn.kind)!;
    const b = await c.req.json().catch(() => ({})) as Row;
    const label = b.label === undefined ? conn.label : String(b.label).trim().slice(0, 80) || conn.label;
    const hasValues = b.values && Object.values(b.values).some((v) => String(v ?? "").trim() !== "");
    if (!hasValues) { db.prepare("UPDATE connections SET label = ? WHERE id = ?").run(label, conn.id); return c.json({ connection: view(getConnection(conn.id)!, "admin") }); }
    if (!secretValid()) return c.json({ error: SECRET_MESSAGE }, 400);
    let old: Row = {};
    try { old = getSecrets(conn); } catch { /* secrets illisibles : on repart des valeurs reçues */ }
    const parsed = split(m, b.values, { config: conn.config, secrets: old });
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    const { cfg } = parsed;
    const main = primary(m, cfg.secrets);
    const dup = main ? findByFingerprint(m.id, main) : undefined;
    if (dup && dup.id !== conn.id) return c.json({ error: `Cette clé est déjà enregistrée sous « ${dup.label} ».` }, 409);
    const result = await runTest(m, cfg, ctx());
    if (!result.ok) { logSafe(cfg, new Error(`${m.id} : ${result.error}`)); return c.json({ error: result.error ?? "Test échoué", failure: result.failure }, 400); }
    try {
      setSecrets(conn.id, cfg.secrets, main ? fingerprint(m.id, main) : null);
      db.prepare("UPDATE connections SET label = ?, config = ?, account = ?, livemode = ? WHERE id = ?")
        .run(label, JSON.stringify({ ...cfg.config, ...(result.settings ?? {}), hint: m.hint(cfg), ...(result.livemode === false ? { test: true } : {}) }), result.account ?? conn.account, result.livemode ? 1 : 0, conn.id);
      markStatus(conn.id, "connected", null);
      return c.json({ connection: view(getConnection(conn.id)!, "admin"), test: { label: result.label, detail: result.detail, warnings: result.warnings ?? [] } });
    } catch (e) {
      if (e instanceof VaultError) return c.json({ error: e.message }, 400);
      logSafe(cfg, e); return c.json({ error: "Enregistrement impossible." }, 500);
    }
  });

  // Relance test() sur une connexion existante : met à jour le statut, ne modifie rien d'autre (P3)
  app.post("/api/connections/:id/test", async (c) => {
    if (!isAdmin(c)) return forbidden(c);
    const conn = getConnection(c.req.param("id"));
    if (!conn) return c.json({ error: "Connexion introuvable" }, 404);
    const m = get(conn.kind);
    if (!m) return c.json({ error: "Connecteur inconnu" }, 400);
    let secrets: Row;
    try { secrets = getSecrets(conn); } catch (e) { return c.json({ ok: false, error: (e as Error).message, failure: "auth", status: "reconnect" }, 409); }
    const cfg: Cfg = { config: conn.config, secrets };
    const result = await runTest(m, cfg, ctx());
    markStatus(conn.id, statusOf(result), result.ok ? null : result.error ?? null);
    return c.json({ ok: result.ok, label: result.label, detail: result.detail, warnings: result.warnings ?? [], error: result.error, failure: result.failure, status: statusOf(result) });
  });

  app.delete("/api/connections/:id", (c) => {
    if (!isAdmin(c)) return forbidden(c);
    if (DEMO()) return c.json({ error: "Désactivé en démonstration." }, 403);
    return removeConnection(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "Connexion introuvable" }, 404);
  });
}

/** Outil MCP en lecture seule : liste des connexions (id, type, libellé, indice, statut) et rien d'autre (R11). */
export function registerConnectionTools(server: McpServer) {
  server.registerTool("connections_list", {
    description: "Liste les connexions aux services (Stripe, Google, SMTP…) : type, libellé, indice et statut. Ne renvoie jamais de clé.",
    inputSchema: z.object({}),
  }, async () => ({ content: [{ type: "text" as const, text: JSON.stringify(listForClients(), null, 2) }] }));
}
