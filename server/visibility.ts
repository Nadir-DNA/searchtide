// Visibilité dans les IA (plan B5) : des questions types posées chaque semaine aux IA connectées (Claude, ChatGPT,
// Gemini, modèle local). Pour chaque réponse : votre marque ou votre site est-il cité, à quelle place, et qui l'est à côté.
// Les réponses varient d'un appel à l'autre : on lit une tendance sur plusieurs semaines, pas un classement.
// Les modèles répondent de mémoire (sans recherche web) : c'est ce qu'ils « savent » de vous, pas un moteur de recherche.
import type { Hono } from "hono";
import type { McpServer } from "@modelcontextprotocol/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "./db.ts";
import { migrate } from "./migrations.ts";
import { registerJob } from "./jobs.ts";
import { isAdmin } from "./admin.ts";
import { aiConnections, complete, type AiConn } from "./assistant.ts";
import { AI_PROVIDERS } from "./connectors/ai.ts";
import { addTodaySource, itemKey, type TodayItem } from "./today.ts";

type Row = Record<string, any>;

migrate("2026-11-16-visibilite-ia", `
CREATE TABLE ai_prompts (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, question TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE ai_brand (project_id TEXT PRIMARY KEY, names TEXT NOT NULL DEFAULT '[]', competitors TEXT NOT NULL DEFAULT '[]');
CREATE TABLE ai_checks (id INTEGER PRIMARY KEY AUTOINCREMENT, prompt_id TEXT NOT NULL, connection_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
  week TEXT NOT NULL, at INTEGER NOT NULL, answer TEXT, cited INTEGER, rank INTEGER, competitors TEXT, error TEXT, UNIQUE (prompt_id, connection_id, week));`);

const MAX_PROMPTS = 20;
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Semaine ISO (2026-W46), pour ne poser chaque question qu'une fois par semaine et par IA. */
export function isoWeek(d = new Date()) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear(), w = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / 86_400_000 + 1) / 7);
  return `${y}-W${String(w).padStart(2, "0")}`;
}

/** Noms qui désignent le projet : son nom, ses domaines (avec et sans extension), les variantes saisies. */
export function brandTerms(projectId: string): { brand: string[]; competitors: string[] } {
  const p = db.prepare("SELECT name, sites FROM projects WHERE id = ?").get(projectId) as Row | undefined;
  const b = db.prepare("SELECT names, competitors FROM ai_brand WHERE project_id = ?").get(projectId) as Row | undefined;
  const domains: string[] = (() => { try { return JSON.parse(p?.sites ?? "[]"); } catch { return []; } })();
  const brand = new Set<string>([...(p?.name ? [String(p.name)] : []), ...domains, ...domains.map((d) => d.replace(/^www\./, "").split(".")[0]), ...JSON.parse(b?.names ?? "[]")]);
  return { brand: [...brand].map((x) => x.trim()).filter((x) => x.length >= 3), competitors: JSON.parse(b?.competitors ?? "[]") };
}

/** Où apparaît un nom dans le texte (mot entier, sans accents ni casse) ; -1 s'il n'y est pas. */
const findTerm = (text: string, term: string) => {
  const m = new RegExp(`(^|[^\\p{L}\\p{N}])${esc(norm(term))}(?=$|[^\\p{L}\\p{N}])`, "u").exec(norm(text));
  return m ? m.index + m[1].length : -1;
};

/**
 * Analyse d'une réponse : citée ou non, et place parmi les marques nommées (les concurrents saisis et les domaines trouvés).
 * La place est l'ordre d'apparition : 1 = nommé en premier.
 */
export function analyzeAnswer(answer: string, brand: string[], competitors: string[]) {
  const at = (terms: string[]) => Math.min(...terms.map((t) => findTerm(answer, t)).filter((i) => i >= 0), Infinity);
  const mine = at(brand);
  const brandNorm = new Set(brand.map(norm));
  const domains = [...new Set((answer.match(/\b[a-z0-9][a-z0-9-]{1,62}\.(?:com|fr|io|co|net|org|app|ai|eu|be|ch|de|es|it|uk)\b/gi) ?? []).map((d) => d.toLowerCase()))]
    .filter((d) => !brandNorm.has(norm(d)) && !brand.some((b) => norm(d).startsWith(norm(b) + ".")));
  const others = [...competitors.map((c) => ({ name: c, pos: findTerm(answer, c) })), ...domains.filter((d) => !competitors.some((c) => norm(d).includes(norm(c)))).map((d) => ({ name: d, pos: findTerm(answer, d) }))]
    .filter((o) => o.pos >= 0).sort((a, b) => a.pos - b.pos);
  const cited = Number.isFinite(mine);
  return { cited, rank: cited ? others.filter((o) => o.pos < mine).length + 1 : null, competitors: others.map((o) => o.name).slice(0, 10) };
}

export function addPrompt(projectId: string, question: string) {
  const q = String(question ?? "").trim().slice(0, 300);
  if (q.length < 8) throw new Error("Question de 8 caractères au moins");
  if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) throw new Error("Projet introuvable");
  if ((db.prepare("SELECT COUNT(*) AS n FROM ai_prompts WHERE project_id = ?").get(projectId) as Row).n >= MAX_PROMPTS) throw new Error(`${MAX_PROMPTS} questions au plus par projet`);
  const id = randomUUID();
  db.prepare("INSERT INTO ai_prompts (id, project_id, question, created_at) VALUES (?, ?, ?, ?)").run(id, projectId, q, Date.now());
  return { id, question: q };
}
export function setBrand(projectId: string, input: { names?: unknown; competitors?: unknown }) {
  const list = (v: unknown) => [...new Set((Array.isArray(v) ? v : String(v ?? "").split(/[,\n]/)).map((x) => String(x).trim()).filter((x) => x.length >= 2 && x.length <= 80))].slice(0, 30);
  db.prepare(`INSERT INTO ai_brand (project_id, names, competitors) VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET names = excluded.names, competitors = excluded.competitors`)
    .run(projectId, JSON.stringify(list(input.names)), JSON.stringify(list(input.competitors)));
  return brandTerms(projectId);
}

const SYSTEM = "Tu réponds à un internaute francophone qui cherche un produit, un service ou un prestataire. Donne une réponse utile et concrète : cite des marques, entreprises ou sites précis quand c'est pertinent, dans l'ordre où tu les recommandes.";

type Ask = (conn: AiConn, question: string) => Promise<string>;
const askWith: Ask = (conn, question) => complete(conn, SYSTEM, question, { maxTokens: 2000 });

/** Pose les questions de la semaine qui ne l'ont pas encore été. `ask` et `now` remplaçables dans les tests. */
export async function runVisibility(o: { project?: string; ask?: Ask; now?: Date; limit?: number } = {}) {
  const week = isoWeek(o.now ?? new Date());
  const conns = aiConnections();
  if (!conns.length) return { asked: 0, reason: "Aucune IA connectée" };
  const prompts = db.prepare(`SELECT * FROM ai_prompts ${o.project ? "WHERE project_id = ?" : ""} ORDER BY created_at`).all(...(o.project ? [o.project] : [])) as Row[];
  let asked = 0;
  for (const p of prompts) {
    const terms = brandTerms(p.project_id);
    for (const c of conns) {
      if (asked >= (o.limit ?? 200)) return { asked };
      const claimed = db.prepare("INSERT OR IGNORE INTO ai_checks (prompt_id, connection_id, provider, model, week, at) VALUES (?, ?, ?, ?, ?, ?)").run(p.id, c.id, c.provider, c.model, week, Date.now());
      if (!claimed.changes) continue;
      asked++;
      try {
        const answer = await (o.ask ?? askWith)(c, p.question);
        const a = analyzeAnswer(answer, terms.brand, terms.competitors);
        db.prepare("UPDATE ai_checks SET answer = ?, cited = ?, rank = ?, competitors = ?, at = ? WHERE prompt_id = ? AND connection_id = ? AND week = ?")
          .run(answer.slice(0, 20_000), a.cited ? 1 : 0, a.rank, JSON.stringify(a.competitors), Date.now(), p.id, c.id, week);
      } catch (e) {
        db.prepare("UPDATE ai_checks SET error = ?, at = ? WHERE prompt_id = ? AND connection_id = ? AND week = ?").run((e as Error).message.slice(0, 300), Date.now(), p.id, c.id, week);
      }
    }
  }
  return { asked };
}

/** Rapport d'un projet : part des réponses qui vous citent, par IA et par semaine (8 dernières), et détail par question. */
export function visibilityReport(projectId: string) {
  const prompts = db.prepare("SELECT id, question FROM ai_prompts WHERE project_id = ? ORDER BY created_at").all(projectId) as Row[];
  const ids = prompts.map((p) => p.id);
  const ph = ids.map(() => "?").join(",") || "''";
  const weeks = (db.prepare(`SELECT DISTINCT week FROM ai_checks WHERE prompt_id IN (${ph}) ORDER BY week DESC LIMIT 8`).all(...ids) as Row[]).map((r) => String(r.week)).reverse();
  const rows = weeks.length ? db.prepare(`SELECT provider, model, week, COUNT(*) AS n, SUM(cited) AS cited, AVG(CASE WHEN cited = 1 THEN rank END) AS rank
    FROM ai_checks WHERE prompt_id IN (${ph}) AND error IS NULL AND cited IS NOT NULL AND week >= ? GROUP BY provider, model, week ORDER BY week`).all(...ids, weeks[0]) as Row[] : [];
  const models = [...new Set(rows.map((r) => `${r.provider}|${r.model}`))].map((k) => {
    const [provider, model] = k.split("|");
    const series = weeks.map((w) => { const r = rows.find((x) => x.provider === provider && x.model === model && x.week === w); return r ? { week: w, share: Math.round((r.cited / r.n) * 100), answers: r.n, rank: r.rank == null ? null : Math.round(r.rank * 10) / 10 } : { week: w, share: null, answers: 0, rank: null }; });
    return { provider, label: AI_PROVIDERS[provider as keyof typeof AI_PROVIDERS]?.label ?? provider, model, series, last: [...series].reverse().find((s) => s.share != null) ?? null };
  });
  const latest = weeks.at(-1);
  const details = prompts.map((p) => ({
    id: p.id, question: p.question,
    answers: latest ? (db.prepare("SELECT provider, model, cited, rank, competitors, error, answer FROM ai_checks WHERE prompt_id = ? AND week = ?").all(p.id, latest) as Row[])
      .map((a) => ({ ...a, cited: a.cited == null ? null : !!a.cited, competitors: JSON.parse(a.competitors ?? "[]"), answer: a.answer ? String(a.answer).slice(0, 1500) : null })) : [],
  }));
  const counts = new Map<string, number>();
  for (const d of details) for (const a of d.answers) for (const c of a.competitors) counts.set(c, (counts.get(c) ?? 0) + 1);
  return { week: latest ?? null, weeks, models, prompts: details, brand: brandTerms(projectId), connected: aiConnections().length,
    rivals: [...counts].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, n]) => ({ name, n })) };
}

/** Alerte dans « À traiter » : part de citation en recul de 20 points ou plus d'une semaine sur l'autre, pour une IA. */
function visibilityAlerts(): TodayItem[] {
  const out: TodayItem[] = [];
  for (const p of db.prepare("SELECT DISTINCT p.id, p.name FROM projects p JOIN ai_prompts q ON q.project_id = p.id").all() as Row[]) {
    for (const m of visibilityReport(p.id).models) {
      const s = m.series.filter((x) => x.share != null);
      if (s.length < 2) continue;
      const [a, b] = s.slice(-2);
      if (a.share! - b.share! >= 20) out.push({ key: itemKey("visibilite-ia", p.id, m.provider, b.week), kind: "alerte", tone: "warn", project_id: p.id,
        text: `${p.name} · ${m.label} vous cite moins : ${a.share} % → ${b.share} % des réponses`, to: { view: "project", id: p.id, tab: "ia" } });
    }
  }
  return out;
}
addTodaySource(visibilityAlerts);

export function registerVisibility(app: Hono) {
  registerJob("projets", { id: "visibilite-ia", every: "24h", run: async () => { await runVisibility(); } });
  const admin = (c: any) => isAdmin(c) ? null : c.json({ error: "Réservé à l'administrateur" }, 403);
  const wrap = (fn: (c: any) => Promise<Response> | Response) => async (c: any) => { const d = admin(c); if (d) return d; try { return await fn(c); } catch (e) { return c.json({ error: (e as Error).message }, 400); } };
  const pid = (c: any) => { const p = db.prepare("SELECT id FROM projects WHERE id = ? OR crm_key = ?").get(c.req.param("id"), c.req.param("id")) as Row | undefined; if (!p) throw new Error("Projet introuvable"); return String(p.id); };
  app.get("/api/projects/:id/ai-visibility", wrap((c) => c.json(visibilityReport(pid(c)))));
  app.post("/api/projects/:id/ai-prompts", wrap(async (c) => c.json(addPrompt(pid(c), (await c.req.json().catch(() => ({}))).question), 201)));
  app.delete("/api/projects/:id/ai-prompts/:pid", wrap((c) => {
    db.prepare("DELETE FROM ai_checks WHERE prompt_id = ?").run(c.req.param("pid"));
    return c.json({ ok: db.prepare("DELETE FROM ai_prompts WHERE id = ? AND project_id = ?").run(c.req.param("pid"), pid(c)).changes > 0 });
  }));
  app.put("/api/projects/:id/ai-brand", wrap(async (c) => c.json(setBrand(pid(c), await c.req.json().catch(() => ({}))))));
  app.post("/api/projects/:id/ai-visibility/run", wrap(async (c) => { await runVisibility({ project: pid(c), limit: 60 }); return c.json(visibilityReport(pid(c))); }));
}

export function registerVisibilityTools(server: McpServer) {
  server.registerTool("ai_visibility", {
    description: "Visibilité d'un projet dans les réponses des IA (Claude, ChatGPT, Gemini…) : part des réponses qui le citent par IA et par semaine, place moyenne, concurrents cités à côté, détail par question type. Tendance indicative : les réponses des IA varient.",
    inputSchema: z.object({ project: z.string().describe("id ou clé du projet") }),
  }, async ({ project }) => {
    const p = db.prepare("SELECT id FROM projects WHERE id = ? OR crm_key = ?").get(project, project) as Row | undefined;
    if (!p) throw new Error("Projet introuvable");
    const r = visibilityReport(String(p.id));
    return { content: [{ type: "text" as const, text: JSON.stringify({ ...r, prompts: r.prompts.map((x) => ({ ...x, answers: x.answers.map(({ answer: _a, ...rest }) => rest) })) }, null, 2) }] };
  });
}
