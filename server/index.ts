import { Hono, type Context, type Next } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { getConnInfo } from "@hono/node-server/conninfo";
import { getSignedCookie, setSignedCookie, deleteCookie } from "hono/cookie";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { db, localDay, type Site } from "./db.ts";
import { collect } from "./collect.ts";
import { lastDays, overview, searchStats, strikingDistance, trafficStats, type Range } from "./stats.ts";
import { gscConfigured, listProperties, syncAll, syncSite } from "./gsc.ts";
import { handleMcp } from "./mcp.ts";
import { registerBusiness } from "./business.ts";
import { registerReport } from "./report.ts";
import { registerProjects } from "./projects.ts";
import { registerConnections, startVault } from "./connections.ts";
import { registerOps } from "./ops.ts";
import { registerPortfolio } from "./portfolio.ts";
import { findAgent, registerAgents } from "./agents.ts";
import { registerDashboards } from "./dashboards.ts";
import { registerOutreach } from "./outreach.ts";
import { backup, loginLimiter, verifyTotp } from "./security.ts";

const SECRET = process.env.SECRET ?? "dev-secret";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "";
const API_KEY = process.env.API_KEY ?? "";
// Clé en lecture seule pour les agents : statistiques et outils MCP sans écriture
const API_KEY_READ = process.env.API_KEY_READ ?? "";
// Double authentification : secret TOTP (base32), créé par `npm run 2fa`
const TOTP_SECRET = process.env.TOTP_SECRET ?? "";
const BACKUP_DIR = process.env.BACKUP_DIR ?? (process.env.DATABASE_PATH?.startsWith("/data/") ? "/data/backups" : "data/backups");
// Démo publique : lecture ouverte à tous, écriture toujours protégée
const DEMO = process.env.DEMO === "1";
if (process.env.NODE_ENV === "production" && (SECRET === "dev-secret" || !ADMIN_PASSWORD)) {
  throw new Error("SECRET et ADMIN_PASSWORD sont obligatoires en production");
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const tracker = readFileSync(new URL("./tracker.js", import.meta.url), "utf8");

const app = new Hono();

// ── Collecte publique (appelée depuis les sites suivis) ──
app.get("/script.js", (c) => c.body(tracker, 200, {
  "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=3600",
}));
app.options("/api/collect", (c) => c.body(null, 204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" }));
app.post("/api/collect", async (c) => {
  const hit = await c.req.json().catch(() => null); // sendBeacon envoie du text/plain
  const ip = c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? getConnInfo(c).remote.address ?? "";
  const country = c.req.header("cf-ipcountry") ?? c.req.header("x-vercel-ip-country") ?? c.req.header("x-country") ?? null;
  if (hit) collect(hit, ip, c.req.header("user-agent") ?? "", country);
  return c.body(null, 202, { "Access-Control-Allow-Origin": "*" });
});

// Santé de l'instance, pour la surveillance externe
app.get("/healthz", (c) => { db.prepare("SELECT 1").get(); return c.json({ ok: true }); });

// ── Authentification : mot de passe admin (+ code TOTP) par cookie, ou clé API (agents) ──
const limiter = loginLimiter();
const clientIp = (c: Context) => c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? getConnInfo(c).remote.address ?? "";
app.get("/api/auth-config", (c) => c.json({ totp: !!TOTP_SECRET }));
app.post("/api/login", async (c) => {
  const ip = clientIp(c);
  if (limiter.blocked(ip)) return c.json({ error: "Trop d'essais : réessayez dans 15 minutes" }, 429);
  const { password, code } = await c.req.json().catch(() => ({ password: "", code: "" }));
  const okPassword = !!ADMIN_PASSWORD && typeof password === "string" && same(password, ADMIN_PASSWORD);
  const okCode = !TOTP_SECRET || (typeof code === "string" && verifyTotp(TOTP_SECRET, code.replace(/\s/g, "")));
  if (!okPassword || !okCode) {
    limiter.fail(ip);
    return c.json({ error: okPassword ? "Code de vérification incorrect" : "Mot de passe incorrect" }, 401);
  }
  limiter.reset(ip);
  await setSignedCookie(c, "st_session", "admin", SECRET, {
    httpOnly: true, sameSite: "Lax", secure: (c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol.replace(":", "")) === "https", maxAge: 30 * 86400, path: "/",
  });
  return c.json({ ok: true });
});
app.post("/api/logout", (c) => { deleteCookie(c, "st_session", { path: "/" }); return c.json({ ok: true }); });

async function auth(c: Context, next: Next) {
  const bearer = c.req.header("authorization")?.replace(/^Bearer /, "");
  if (API_KEY && bearer && same(bearer, API_KEY)) return next();
  // Clé d'agent : mêmes droits que la clé principale (ou lecture seule), mais elle ne peut pas gérer les clés
  const agent = findAgent(bearer);
  if (agent) {
    if (c.req.path.startsWith("/api/agents") && c.req.method !== "GET") return c.json({ error: "Les clés d'agent se gèrent depuis l'interface" }, 403);
    if (!agent.readOnly || c.req.method === "GET" || c.req.path === "/mcp") return next();
    return c.json({ error: "Clé en lecture seule" }, 403);
  }
  if (API_KEY_READ && bearer && same(bearer, API_KEY_READ)) {
    // Lecture seule : GET, et MCP avec les seuls outils de lecture (voir la route /mcp)
    if (c.req.method === "GET" || c.req.path === "/mcp") return next();
    return c.json({ error: "Clé en lecture seule" }, 403);
  }
  if ((await getSignedCookie(c, SECRET, "st_session")) === "admin") return next();
  if (DEMO && c.req.method === "GET") return next();
  return c.json({ error: "Non authentifié" }, 401);
}
app.use("/api/*", auth);
app.use("/mcp", auth);

app.all("/mcp", (c) => {
  const bearer = c.req.header("authorization")?.replace(/^Bearer /, "") ?? "";
  const agent = findAgent(bearer);
  if (agent) return handleMcp(c.req.raw, { readOnly: agent.readOnly, agent: agent.name });
  return handleMcp(c.req.raw, { readOnly: !!API_KEY_READ && same(bearer, API_KEY_READ), agent: API_KEY && same(bearer, API_KEY) ? "Clé principale" : "Clé lecture seule" });
});

// ── API privée ──
const getSite = (id: string) => db.prepare("SELECT * FROM sites WHERE id = ? OR domain = ?").get(id, id) as Site | undefined;
const rangeOf = (c: Context): Range => {
  const { from, to, days } = c.req.query();
  const ok = (d?: string) => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d);
  return ok(from) && ok(to) ? { from: from!, to: to! } : lastDays(Math.min(Math.max(Number(days) || 28, 1), 500));
};

app.get("/api/me", (c) => c.json({ ok: true, gsc: gscConfigured(), demo: DEMO }));
app.get("/api/overview", (c) => c.json(overview(rangeOf(c))));

app.get("/api/sites", (c) => c.json(db.prepare(`SELECT s.*, g.synced_at, g.last_day, g.error AS sync_error,
  (SELECT COUNT(DISTINCT visitor) FROM events e WHERE e.site_id = s.id AND e.day = ? AND e.type = 'pageview') AS today
  FROM sites s LEFT JOIN gsc_syncs g ON g.site_id = s.id ORDER BY s.domain`).all(localDay())));

app.post("/api/sites", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const domain = String(b.domain ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return c.json({ error: "Domaine invalide" }, 400);
  if (getSite(domain)) return c.json({ error: "Ce site existe déjà" }, 409);
  const site: Site = { id: randomUUID(), domain, name: String(b.name || domain).slice(0, 100), gsc_property: b.gsc_property || null, created_at: Date.now() };
  db.prepare("INSERT INTO sites (id, domain, name, gsc_property, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(site.id, site.domain, site.name, site.gsc_property, site.created_at);
  return c.json(site, 201);
});

app.patch("/api/sites/:id", async (c) => {
  const s = getSite(c.req.param("id"));
  if (!s) return c.json({ error: "Site introuvable" }, 404);
  const b = await c.req.json().catch(() => ({}));
  db.prepare("UPDATE sites SET name = ?, gsc_property = ? WHERE id = ?")
    .run(String(b.name ?? s.name).slice(0, 100), b.gsc_property === undefined ? s.gsc_property : b.gsc_property || null, s.id);
  return c.json(getSite(s.id));
});

app.delete("/api/sites/:id", (c) => {
  const r = db.prepare("DELETE FROM sites WHERE id = ?").run(c.req.param("id"));
  return r.changes ? c.json({ ok: true }) : c.json({ error: "Site introuvable" }, 404);
});

app.get("/api/sites/:id/traffic", (c) => {
  const s = getSite(c.req.param("id"));
  return s ? c.json(trafficStats(s.id, rangeOf(c))) : c.json({ error: "Site introuvable" }, 404);
});
app.get("/api/sites/:id/search", (c) => {
  const s = getSite(c.req.param("id"));
  if (!s) return c.json({ error: "Site introuvable" }, 404);
  const r = rangeOf(c);
  return c.json({ ...searchStats(s.id, r), opportunities: strikingDistance(s.id, r) });
});
app.post("/api/sites/:id/sync", async (c) => {
  const s = getSite(c.req.param("id"));
  if (!s) return c.json({ error: "Site introuvable" }, 404);
  try { return c.json(await syncSite(s)); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
});
app.get("/api/gsc/properties", async (c) => {
  try { return c.json(await listProperties()); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
});

registerBusiness(app);
registerReport(app);
registerProjects(app)
registerConnections(app);
startVault();
registerOps(app);
registerPortfolio(app);
registerAgents(app);
registerDashboards(app);
registerOutreach(app);

// ── Interface (build Vite) ──
app.use("/*", serveStatic({ root: "./web/dist" }));
app.get("*", serveStatic({ path: "./web/dist/index.html" }));

// Synchro Search Console : au démarrage puis toutes les 6 h
const SYNC_MS = 6 * 3600 * 1000;
setTimeout(() => void syncAll(), 10_000);
setInterval(() => void syncAll(), SYNC_MS).unref();

// Sauvegarde quotidienne (vers 2 h UTC) dans BACKUP_DIR, 14 jours gardés
let lastBackup = "";
setInterval(() => {
  const d = new Date();
  if (d.getUTCHours() !== 2 || lastBackup === d.toISOString().slice(0, 10)) return;
  lastBackup = d.toISOString().slice(0, 10);
  try { console.log(`Sauvegarde : ${backup(BACKUP_DIR)}`); } catch (e) { console.error("[sauvegarde]", (e as Error).message); }
}, 10 * 60 * 1000).unref();

const port = Number(process.env.PORT ?? 3030);
// Écoute locale par défaut : sans HOST explicite, rien n'est joignable depuis le réseau.
// Docker exige une écoute interne large pour publier un port (le port publié reste borné à 127.0.0.1 côté hôte).
const inContainer = existsSync("/.dockerenv");
const hostname = process.env.HOST ?? (inContainer ? "0.0.0.0" : "127.0.0.1");
if (!inContainer && hostname !== "127.0.0.1" && hostname !== "localhost" && !TOTP_SECRET && !DEMO) {
  console.warn(`Attention : Searchtide est joignable sur ${hostname} sans double authentification. Activez-la (npm run 2fa) ou bornez HOST à 127.0.0.1.`);
}
serve({ fetch: app.fetch, port, hostname }, () => console.log(`Searchtide sur http://localhost:${port}`));

export { app };
