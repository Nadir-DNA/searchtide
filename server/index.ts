import { Hono, type Context, type Next } from "hono";
import { jobsStatus, registerJob, startJobs } from "./jobs.ts";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { clientIp } from "./net.ts";
import { getSignedCookie, setSignedCookie, deleteCookie } from "hono/cookie";
import { existsSync, readFileSync } from "node:fs";
import { bootFiles, bootValue } from "./bootstrap.ts";
import { seedDemo } from "./demo-data.ts";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { db, localDay, type Site } from "./db.ts";
import { collect, refusals } from "./collect.ts";
import { activate, backupCodesLeft, consumeSecondFactor, consumeTotp, disable, enabledInSettings, settingsSecret, startSetup, twofaConfigured } from "./twofa.ts";
import { bumpEpoch, sessionValue, validSession } from "./sessions.ts";
import { missing2faWarning } from "./twofa-warning.ts";
import { lastDays, overview, searchStats, strikingDistance, trafficStats, type Range } from "./stats.ts";
import { convertGoogleEnv, gscConfigured, listProperties, setSiteGscProperty, syncAll, syncSite } from "./gsc.ts";
import { handleMcp, mcpAccess } from "./mcp.ts";
import { registerBusiness } from "./business.ts";
import { accountBelongsToProject, registerPublishers } from "./publishers/queue.ts";
import { fixturesEnabled } from "./browser/pool.ts";
import { FIXTURE_PATHS, startFixtures } from "./browser/fixtures.ts";
import { registerMedia } from "./publishers/media.ts";
import { registerReport } from "./report.ts";
import { registerProjects } from "./projects.ts";
import { startVault } from "./connections.ts";
import { registerConnections } from "./connectors/api.ts";
import { registerSources } from "./sources.ts";
import { registerOps } from "./ops.ts";
import { registerPortfolio } from "./portfolio.ts";
import { registerStripeOAuth } from "./stripe-oauth.ts";
import { registerPublisherOAuth } from "./publishers/oauth.ts";
import { canAccess, findAgent, projectForPath, registerAgents, visibleDomains, visibleProjectIds, writableProjectIds } from "./agents.ts";
import { registerApprovals } from "./approvals.ts";
import { registerDashboards } from "./dashboards.ts";
import { registerOutreach } from "./outreach.ts";
import { backup } from "./security.ts";
import { markAdmin, markClient, isAdmin } from "./admin.ts";
import { blocked, fail, resetIp } from "./security-limits.ts";
import { securityEvent } from "./security-events.ts";
import { freshness } from "./freshness.ts";
import { runAsViewer } from "./viewer.ts";
import { unknownConfigKeys } from "./projects.ts";
import { hasSecretKey, hasUrlSecret } from "./mask.ts";
import { countEventsBefore, purgeEventsBefore } from "./retention.ts";
import { recentSecurityEvents } from "./security-events.ts";
import { activateFromExistingData, isEnabled } from "./modules/state.ts";
import { registerModules } from "./modules/api.ts";
import { loadPlugins } from "./modules/plugins.ts";
import { registerToday } from "./today.ts";
import { closeLive, liveStatus, sendInput, startLive, subscribe } from "./browser/live.ts";
import { streamSSE } from "hono/streaming";

const PRODUCTION = process.env.NODE_ENV === "production";
const DB_PATH = process.env.DATABASE_PATH ?? "data/searchtide.db";
const boot = bootFiles(DB_PATH);
// T24 : au premier lancement en production (image Docker), SECRET et ADMIN_PASSWORD sont générés et rangés à côté de la base.
// Une variable d'environnement reste prioritaire ; en développement, SECRET garde sa valeur de travail.
const generatedSecret = PRODUCTION && !process.env.SECRET ? bootValue(undefined, boot.secret, 32, "hex") : null;
if (generatedSecret) process.env.SECRET = generatedSecret.value;
const generatedPassword = PRODUCTION && !process.env.ADMIN_PASSWORD ? bootValue(undefined, boot.password, 12, "password") : null;
if (generatedPassword) process.env.ADMIN_PASSWORD = generatedPassword.value;
const SECRET = process.env.SECRET ?? "dev-secret";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "";
const API_KEY = process.env.API_KEY ?? "";

// SEC-03 : valeur révocable admin.<epoch>.<empreinte du mot de passe>.
const setSessionCookie = (c: Context) => setSignedCookie(c, "st_session", sessionValue(ADMIN_PASSWORD), SECRET, {
  httpOnly: true, sameSite: "Lax", secure: (c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol.replace(":", "")) === "https", maxAge: 30 * 86400, path: "/",
});
// Clé en lecture seule pour les agents : statistiques et outils MCP sans écriture
const API_KEY_READ = process.env.API_KEY_READ ?? "";
// Double authentification : secret TOTP (base32), créé par `npm run 2fa`
const TOTP_SECRET = process.env.TOTP_SECRET ?? "";
const BACKUP_DIR = process.env.BACKUP_DIR ?? (process.env.DATABASE_PATH?.startsWith("/data/") ? "/data/backups" : "data/backups");
// Démo publique : lecture ouverte à tous, écriture toujours protégée
const DEMO = process.env.DEMO === "1";
if (DEMO) {
  try { if (seedDemo()) console.log("[Searchtide] Démonstration : données fictives créées (exemple.com, exemple-boutique.com)."); }
  catch (e) { console.error("[démonstration] données fictives non créées :", (e as Error).message); }
}
if (PRODUCTION && (SECRET === "dev-secret" || SECRET.length < 32 || !ADMIN_PASSWORD)) {
  throw new Error("SECRET (32 caractères au moins) et ADMIN_PASSWORD sont obligatoires en production");
}
if (generatedSecret?.created) {
  console.log(`[Searchtide] SECRET généré et enregistré dans ${generatedSecret.file} (droits 600).`);
  try {
    const n = (db.prepare("SELECT COUNT(*) AS n FROM connections").get() as { n: number }).n;
    if (n > 0) console.warn(`[Searchtide] ATTENTION : SECRET régénéré alors que ${n} connexion(s) chiffrée(s) existent ; elles sont illisibles. Restaurez /data/secret depuis une sauvegarde complète (base + secret + admin-password).`);
  } catch { /* table des connexions absente : rien à signaler */ }
}
if (generatedPassword?.created) console.log(`[Searchtide] Mot de passe administrateur généré : ${generatedPassword.value}\n[Searchtide]   enregistré dans ${generatedPassword.file} (droits 600) ; définissez ADMIN_PASSWORD pour le choisir.`);

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const tracker = readFileSync(new URL("./tracker.js", import.meta.url), "utf8");
// Version du paquet : affichage et /healthz (la surveillance ne teste que `ok`).
const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;

const app = new Hono();

// SEC-09d : compte les configs héritées hors schéma/sensibles, sans valeur ni suppression.
try {
  const rows = db.prepare("SELECT source, config FROM indicators").all() as { source: string; config: string }[];
  const legacy = rows.filter((r) => { try { const c = JSON.parse(r.config); return unknownConfigKeys(r.source, c).length > 0 || hasSecretKey(c) || hasUrlSecret(JSON.stringify(c)); } catch { return false; } }).length;
  if (legacy > 0) securityEvent("legacy_secret_config", String(legacy));
} catch { /* base pas encore prête */ }

// SEC-05 : écritures same-origin en JSON. /api/collect (sendBeacon text/plain) et les clients Bearer sont exclus.
app.use("/api/*", async (c, next) => {
  const method = c.req.method;
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) return next();
  if (c.req.path === "/api/collect") return next();
  // Médias : corps binaire (image/vidéo) vérifié par signature. Seul le contrôle du Content-Type JSON est levé ;
  // le contrôle d'origine (Sec-Fetch-Site, Origin) s'applique comme aux autres écritures (MED-D1).
  const binaryBody = /^\/api\/publications\/[^/]+\/media$/.test(c.req.path);
  if (c.req.header("authorization")) return next();
  if (c.req.header("sec-fetch-site") === "cross-site") return c.json({ error: "Origine non autorisée" }, 403);
  const origin = c.req.header("origin");
  if (origin) {
    let host = "";
    try { host = new URL(origin).host; } catch { return c.json({ error: "Origine non autorisée" }, 403); }
    const allowed = new Set([c.req.header("host") ?? ""].filter(Boolean));
    if (process.env.PUBLIC_URL) { try { allowed.add(new URL(process.env.PUBLIC_URL).host); } catch { /* PUBLIC_URL invalide : ignoré */ } }
    if (!allowed.has(host)) return c.json({ error: "Origine non autorisée" }, 403);
  }
  const length = Number(c.req.header("content-length") ?? "0");
  const hasBody = (Number.isFinite(length) && length > 0) || !!c.req.header("transfer-encoding");
  if (hasBody && !binaryBody) {
    const type = (c.req.header("content-type") ?? "").toLowerCase();
    if (!type.startsWith("application/json")) return c.json({ error: "Content-Type application/json requis" }, 415);
  }
  return next();
});

// ── Collecte publique (appelée depuis les sites suivis) ──
app.get("/script.js", (c) => c.body(tracker, 200, {
  "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=3600",
}));
app.options("/api/collect", (c) => c.body(null, 204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" }));
app.post("/api/collect", async (c) => {
  const hit = await c.req.json().catch(() => null); // sendBeacon envoie du text/plain
  const ip = clientIp(c);
  const country = c.req.header("cf-ipcountry") ?? c.req.header("x-vercel-ip-country") ?? c.req.header("x-country") ?? null;
  if (hit) collect(hit, ip, c.req.header("user-agent") ?? "", country);
  return c.body(null, 202, { "Access-Control-Allow-Origin": "*" });
});

// Santé de l'instance, pour la surveillance externe
app.get("/healthz", (c) => { db.prepare("SELECT 1").get(); return c.json({ ok: true, version: VERSION }); });

// ── Authentification : mot de passe admin (+ code TOTP) par cookie, ou clé API (agents) ──
// SEC-01 : budgets persistants, séparés login / 2FA (voir security-limits.ts).
// Configuration de connexion, publique : dit si un code 2FA est exigé et si le mot de passe a été
// généré au premier démarrage (jamais la valeur). Sert au texte de l'écran de connexion.
app.get("/api/auth-config", (c) => c.json({ totp: !!TOTP_SECRET || twofaConfigured(), passwordGenerated: !!generatedPassword }));
app.post("/api/login", async (c) => {
  const ip = clientIp(c);
  if (blocked("login", ip)) return c.json({ error: "Trop d'essais : réessayez dans 15 minutes" }, 429);
  // SEC-04 : une 2FA activée mais illisible ne retombe jamais silencieusement sur le mot de passe seul.
  if (!TOTP_SECRET && twofaConfigured() && !settingsSecret()) {
    return c.json({ error: "2FA configurée mais illisible : restaurez SECRET ou suivez la procédure de SECURITY.md" }, 503);
  }
  const { password, code } = await c.req.json().catch(() => ({ password: "", code: "" }));
  const okPassword = !!ADMIN_PASSWORD && typeof password === "string" && same(password, ADMIN_PASSWORD);
  // TOTP_SECRET de l'environnement garde la priorité (compatibilité npm run 2fa) ; sinon réglage chiffré + codes de secours.
  // S3 : le second facteur n'est vérifié qu'après un mot de passe correct — un code de secours n'est jamais consommé à tort.
  let factor: "ok" | "replay" | "invalid" = "ok";
  if (okPassword) {
    if (TOTP_SECRET) factor = typeof code === "string" ? consumeTotp(TOTP_SECRET, code) : "invalid";
    else if (enabledInSettings()) factor = typeof code === "string" ? consumeSecondFactor(code) : "invalid";
  }
  if (!okPassword || factor !== "ok") {
    fail("login", ip);
    const error = !okPassword ? "Mot de passe incorrect"
      : factor === "replay" ? "Code déjà utilisé : attendez le code suivant"
      : "Code de vérification incorrect";
    return c.json({ error }, 401);
  }
  resetIp("login", ip);
  await setSessionCookie(c);
  return c.json({ ok: true });
});
app.post("/api/logout", (c) => {
  // SEC-03 : déconnexion de tous les appareils (outil à administrateur unique).
  bumpEpoch();
  deleteCookie(c, "st_session", { path: "/" });
  return c.json({ ok: true });
});

// SEC-06 : les clés lisent en REST une liste blanche ; ces routes sont réservées à l'administrateur.
const READ_PREFIXES = ["/api/freshness", "/api/me", "/api/overview", "/api/sites", "/api/projects", "/api/indicators", "/api/portfolio", "/api/today", "/api/milestones", "/api/annotations", "/api/dashboards", "/api/jobs"];
const ADMIN_PREFIXES = ["/api/ops", "/api/agents", "/api/connections", "/api/contacts", "/api/business", "/api/outreach", "/api/publications", "/api/pub-accounts", "/api/media", "/api/modules", "/api/diagnostic", "/api/2fa", "/api/browser"];
const under = (path: string, prefix: string) => path === prefix || path.startsWith(prefix + "/");
const isAdminOnlyPath = (path: string) => ADMIN_PREFIXES.some((p) => under(path, p)) || /^\/api\/sites\/[^/]+\/(purge|events\/count)$/.test(path);
const isReadPath = (path: string) => READ_PREFIXES.some((p) => under(path, p));
// L1 : agrégats filtrés par portée pour une clé limitée (jamais bloqués, jamais élargis).
const SCOPED_AGGREGATES = new Set(["/api/projects", "/api/overview", "/api/today", "/api/portfolio", "/api/dashboards", "/api/sites"]);
const keyMayRead = (path: string) => !isAdminOnlyPath(path) && isReadPath(path);
// SEC-06b : écritures REST autorisées à une clé. Suppressions, sources et valeurs passent par l'administrateur
// (ou par une approbation, §15.2 point 4).
const KEY_WRITES: [string, RegExp][] = [
  ["POST", /^\/api\/today\/[^/]+$/],
  ["POST", /^\/api\/annotations$/],
  ["PUT", /^\/api\/dashboards\/[^/]+$/],
  ["PUT", /^\/api\/projects\/[^/]+\/modules\/[^/]+$/],
  ["POST", /^\/api\/indicators\/[^/]+\/collect$/],
  ["POST", /^\/api\/indicators\/[^/]+\/value$/],
  ["POST", /^\/api\/indicators\/[^/]+\/values$/],
  ["POST", /^\/api\/sites\/[^/]+\/sync$/],
];
const keyMayWrite = (method: string, path: string) => KEY_WRITES.some(([m, re]) => m === method && re.test(path));

async function auth(c: Context, next: Next) {
  const bearer = c.req.header("authorization")?.replace(/^Bearer /, "");
  if (API_KEY && bearer && same(bearer, API_KEY)) {
    markClient(c);
    if (isAdminOnlyPath(c.req.path)) return c.json({ error: "Réservé à l'administrateur" }, 403);
    if (c.req.method === "GET" && !isReadPath(c.req.path)) return c.json({ error: "Réservé à l'administrateur" }, 403);
    if (c.req.path !== "/mcp" && c.req.method !== "GET" && !keyMayWrite(c.req.method, c.req.path)) return c.json({ error: "Écriture réservée à l'administrateur ou à une approbation" }, 403);
    return next();
  }
  // Clé d'agent : mêmes droits que la clé principale (ou lecture seule), mais elle ne peut pas gérer les clés
  const agent = findAgent(bearer);
  if (agent) {
    markClient(c);
    (c as any).set("agent", agent);
    if (c.req.path.startsWith("/api/agents") && c.req.method !== "GET") return c.json({ error: "Les clés d'agent se gèrent depuis l'interface" }, 403);
    if (isAdminOnlyPath(c.req.path)) return c.json({ error: "Réservé à l'administrateur" }, 403);
    if (c.req.path.startsWith("/api/approvals")) return next();
    // Une clé en lecture seule n'écrit jamais, même dans sa portée.
    if (agent.readOnly && c.req.method !== "GET" && c.req.path !== "/mcp") return c.json({ error: "Clé en lecture seule" }, 403);
    if (!agent.allProjects) {
      const idRoute = /^\/api\/(projects|indicators|sites)\/[^/]+/.test(c.req.path);
      const aggregate = c.req.method === "GET" && SCOPED_AGGREGATES.has(c.req.path);
      const mcp = c.req.path === "/mcp";
      if (!mcp && !idRoute && !aggregate) return c.json({ error: "Hors de la portée de cette clé" }, 403);
      const project = idRoute ? projectForPath(c.req.path) : null;
      // Même réponse pour inexistant, hors portée et site orphelin : aucune fuite d'existence.
      if (idRoute && (!project || !canAccess(agent, project, c.req.method === "GET" ? "read" : "write"))) return c.json({ error: "Introuvable" }, 404);
    }
    if (c.req.method === "GET" && !isReadPath(c.req.path)) return c.json({ error: "Réservé à l'administrateur" }, 403);
    // Actions gardées par approbation : modification/suppression d'un indicateur, suppression d'un projet.
    const indicatorTarget = /^\/api\/indicators\/[^/]+$/.test(c.req.path);
    const projectTarget = /^\/api\/projects\/[^/]+$/.test(c.req.path);
    const guarded = ((indicatorTarget && ["PATCH", "DELETE"].includes(c.req.method)) || (projectTarget && c.req.method === "DELETE")) && !!c.req.header("x-approval-id");
    if (!agent.readOnly && c.req.path !== "/mcp" && c.req.method !== "GET" && !keyMayWrite(c.req.method, c.req.path) && !guarded) return c.json({ error: "Écriture réservée à l'administrateur ou à une approbation" }, 403);
    if (!agent.readOnly || c.req.method === "GET" || c.req.path === "/mcp") return next();
    return c.json({ error: "Clé en lecture seule" }, 403);
  }
  if (API_KEY_READ && bearer && same(bearer, API_KEY_READ)) {
    markClient(c);
    if (isAdminOnlyPath(c.req.path)) return c.json({ error: "Réservé à l'administrateur" }, 403);
    // Lecture seule : GET dans la liste blanche, et MCP avec les seuls outils de lecture.
    if (c.req.method === "GET" && isReadPath(c.req.path)) return next();
    if (c.req.path === "/mcp") return next();
    return c.json({ error: "Clé en lecture seule" }, 403);
  }
  if (validSession(await getSignedCookie(c, SECRET, "st_session"), ADMIN_PASSWORD)) { markAdmin(c); return next(); }
  if (DEMO && c.req.method === "GET") {
    if (isAdminOnlyPath(c.req.path)) return c.json({ error: "Réservé à l'administrateur" }, 403);
    if (isReadPath(c.req.path)) return next();
    return c.json({ error: "Non authentifié" }, 401);
  }
  // SEC-01 : une clé Bearer refusée est un échec de connexion (par IP et global).
  if (bearer) {
    const ip = clientIp(c);
    if (blocked("login", ip)) return c.json({ error: "Trop d'essais : réessayez dans 15 minutes" }, 429);
    fail("login", ip);
  }
  return c.json({ error: "Non authentifié" }, 401);
}
const viewerMask = async (c: Context, next: Next) => runAsViewer(!validSession(await getSignedCookie(c, SECRET, "st_session"), ADMIN_PASSWORD), next);
app.use("/api/*", viewerMask);
app.use("/api/*", auth);
app.use("/mcp", viewerMask);
app.use("/mcp", auth);

app.all("/mcp", async (c) => {
  const bearer = c.req.header("authorization")?.replace(/^Bearer /, "") ?? "";
  const agent = findAgent(bearer);
  if (agent) return handleMcp(c.req.raw, { readOnly: agent.readOnly, agent: agent.name, scope: ((r) => r ? { read: r, write: writableProjectIds(agent)! } : null)(visibleProjectIds(agent)) });
  // Sans en-tête : session administrateur (cookie) ou démonstration anonyme. Un jeton non reconnu n'atteint
  // jamais ce point en POST (401 plus haut) ; s'il arrive par GET SSE, il obtient un serveur en lecture seule.
  const admin = !bearer && validSession(await getSignedCookie(c, SECRET, "st_session"), ADMIN_PASSWORD);
  return handleMcp(c.req.raw, mcpAccess(bearer, { admin, apiKey: !!API_KEY && same(bearer, API_KEY), apiKeyRead: !!API_KEY_READ && same(bearer, API_KEY_READ) }));
});

// B2 : affichage intégré, administrateur seul (clé d'agent, lecture seule, démo, anonyme = 403).
const browserAdmin = (c: Context) => isAdmin(c)
  ? null
  : c.json({ error: "Réservé à l'administrateur (session navigateur)" }, 403);
// Mode recette (BROWSER_FIXTURES=1) : pages de test locales servies par l'instance, visibles dans l'écran. Désactivé par défaut.
let fixtureServer: Awaited<ReturnType<typeof startFixtures>> | null = null;
app.get("/api/browser/fixtures", async (c) => {
  const denied = browserAdmin(c); if (denied) return denied;
  if (process.env.BROWSER_FIXTURES !== "1") return c.json({ enabled: false });
  fixtureServer ??= await startFixtures();
  return c.json({ enabled: true, port: fixtureServer.port, pages: FIXTURE_PATHS.map((path) => ({ path, url: `${fixtureServer!.url}${path}` })) });
});
app.get("/api/browser/status", (c) => browserAdmin(c) ?? c.json(liveStatus()));
app.post("/api/browser/live", async (c) => {
  const denied = browserAdmin(c); if (denied) return denied;
  const b = await c.req.json().catch(() => ({}));
  const url = typeof b.url === "string" ? b.url : "";
  if (!url) return c.json({ error: "Adresse de la page requise" }, 400);
  const fixturePort = Number(b.fixture_port) || 0;
  if (fixturePort && !fixturesEnabled()) return c.json({ error: "Pages de test désactivées sur cette instance" }, 400);
  try { return c.json(await startLive({ url, fixturePort }), 201); }
  catch (e) { return c.json({ error: (e as Error).message }, 400); }
});
app.get("/api/browser/live/stream", async (c) => {
  const denied = browserAdmin(c); if (denied) return denied;
  const ticket = c.req.query("ticket") ?? "";
  c.header("cache-control", "no-store");
  return streamSSE(c, async (stream) => {
    let unsubscribe = () => { /* pas encore abonné */ };
    try { unsubscribe = subscribe(ticket, (jpeg) => { void stream.writeSSE({ event: "frame", data: jpeg }); }); }
    catch (e) { await stream.writeSSE({ event: "error", data: (e as Error).message }); return; }
    // B2-D1 : la coupure du client libère la vue tout de suite (la boucle ci-dessous ne s'interrompt pas toute seule).
    stream.onAbort(() => unsubscribe());
    try {
      // Une image finale peut arriver après la fermeture ; le flux se termine avec la vue.
      while (liveStatus().open && !stream.aborted) await stream.sleep(1000);
      await stream.writeSSE({ event: "closed", data: "vue fermée" });
    } finally { unsubscribe(); }
  });
});
app.post("/api/browser/live/input", async (c) => {
  const denied = browserAdmin(c); if (denied) return denied;
  const b = await c.req.json().catch(() => ({}));
  try { await sendInput(String(b.ticket ?? ""), b.event); return c.json({ ok: true }); }
  catch (e) { return c.json({ error: (e as Error).message }, 400); }
});
app.post("/api/browser/live/close", async (c) => {
  const denied = browserAdmin(c); if (denied) return denied;
  const b = await c.req.json().catch(() => ({}));
  if (b.save) {
    const accountId = typeof b.account_id === "string" ? b.account_id : "";
    const projectId = typeof b.project_id === "string" ? b.project_id : "";
    if (!accountId || !projectId) return c.json({ error: "account_id et project_id requis pour enregistrer la session" }, 400);
    if (!accountBelongsToProject(accountId, projectId)) return c.json({ error: "Compte navigateur ou projet introuvable ou incohérent" }, 400);
    try { return c.json(await closeLive({ accountId, projectId })); }
    catch (e) { return c.json({ error: (e as Error).message }, 400); }
  }
  return c.json(await closeLive());
});

// SEC-08 : journal de sécurité lisible par l'administrateur (sans IP ni secret).
app.get("/api/security/events", (c) => isAdmin(c)
  ? c.json(recentSecurityEvents(Math.min(Number(c.req.query("limit")) || 100, 200)))
  : c.json({ error: "Réservé à l'administrateur" }, 403));

// ── API privée ──
const getSite = (id: string) => db.prepare("SELECT * FROM sites WHERE id = ? OR domain = ?").get(id, id) as Site | undefined;
const rangeOf = (c: Context): Range => {
  const { from, to, days } = c.req.query();
  const ok = (d?: string) => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d);
  return ok(from) && ok(to) ? { from: from!, to: to! } : lastDays(Math.min(Math.max(Number(days) || 28, 1), 500));
};

// 1.4 : double authentification — réservée à la session administrateur (403 pour clé d'agent ou lecture seule).
app.get("/api/2fa", (c) => isAdmin(c)
  ? c.json({ enabled: !!TOTP_SECRET || enabledInSettings(), source: TOTP_SECRET ? "env" : enabledInSettings() ? "settings" : null, codesLeft: backupCodesLeft() })
  : c.json({ error: "Réservé à l'administrateur" }, 403));
// S2/S4 : limiteur par IP (5 échecs / 15 min) et réponses non mises en cache.
const twofaGuard = (c: Context) => {
  const ip = clientIp(c);
  c.header("cache-control", "no-store");
  return { ip, blocked: blocked("twofa", ip) };
};
app.post("/api/2fa/setup", async (c) => {
  if (!isAdmin(c)) return c.json({ error: "Réservé à l'administrateur" }, 403);
  const { ip, blocked } = twofaGuard(c);
  if (blocked) return c.json({ error: "Trop d'essais : réessayez dans 15 minutes" }, 429);
  if (TOTP_SECRET) { fail("twofa", ip); return c.json({ error: "Déjà définie par TOTP_SECRET dans l'environnement" }, 400); }
  // S1 : jamais de remplacement silencieux du secret — un cookie volé ne peut pas réenrôler la 2FA.
  if (enabledInSettings()) { fail("twofa", ip); return c.json({ error: "La double authentification est active : désactivez-la (mot de passe + code) avant de changer de secret" }, 409); }
  resetIp("twofa", ip);
  return c.json(await startSetup());
});
app.post("/api/2fa/activate", async (c) => {
  if (!isAdmin(c)) return c.json({ error: "Réservé à l'administrateur" }, 403);
  const { ip, blocked } = twofaGuard(c);
  if (blocked) return c.json({ error: "Trop d'essais : réessayez dans 15 minutes" }, 429);
  const { code } = await c.req.json().catch(() => ({ code: "" }));
  const codes = typeof code === "string" ? activate(code) : null;
  if (!codes) { fail("twofa", ip); return c.json({ error: "Code invalide ou déjà utilisé : vérifiez l'heure ou attendez le code suivant" }, 400); }
  resetIp("twofa", ip);
  securityEvent("twofa_enabled", "interface");
  bumpEpoch();
  await setSessionCookie(c);
  return c.json({ codes });
});
app.post("/api/2fa/disable", async (c) => {
  if (!isAdmin(c)) return c.json({ error: "Réservé à l'administrateur" }, 403);
  const { ip, blocked } = twofaGuard(c);
  if (blocked) return c.json({ error: "Trop d'essais : réessayez dans 15 minutes" }, 429);
  if (TOTP_SECRET) return c.json({ error: "Désactivez TOTP_SECRET dans l'environnement" }, 400);
  const { password, code } = await c.req.json().catch(() => ({ password: "", code: "" }));
  if (typeof password !== "string" || !same(password, ADMIN_PASSWORD)) { fail("twofa", ip); return c.json({ error: "Mot de passe incorrect" }, 400); }
  if (typeof code !== "string" || consumeSecondFactor(code) !== "ok") { fail("twofa", ip); return c.json({ error: "Code invalide ou déjà utilisé" }, 400); }
  resetIp("twofa", ip);
  disable();
  securityEvent("twofa_disabled", "interface");
  bumpEpoch();
  await setSessionCookie(c);
  return c.json({ ok: true });
});

app.get("/api/freshness", (c) => c.json(freshness()));
app.get("/api/me", (c) => c.json({ ok: true, gsc: gscConfigured() && isEnabled("google"), demo: DEMO }));
app.get("/api/overview", (c) => {
  const agent = (c as any).get("agent");
  return c.json(overview(rangeOf(c), agent ? visibleDomains(agent) : null));
});

app.get("/api/sites", (c) => {
  const agent = (c as any).get("agent");
  const sites = db.prepare(`SELECT s.*, g.synced_at, g.last_day, g.error AS sync_error,
    (SELECT COUNT(DISTINCT visitor) FROM events e WHERE e.site_id = s.id AND e.day = ? AND e.type = 'pageview') AS today
    FROM sites s LEFT JOIN gsc_syncs g ON g.site_id = s.id ORDER BY s.domain`).all(localDay());
  const domains = agent ? visibleDomains(agent) : null;
  return c.json(domains ? sites.filter((s: any) => domains.has(s.domain)) : sites);
});

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
  db.prepare("UPDATE sites SET name = ? WHERE id = ?").run(String(b.name ?? s.name).slice(0, 100), s.id);
  if (b.gsc_property !== undefined) setSiteGscProperty(s.id, b.gsc_property || null);
  return c.json(getSite(s.id));
});

app.delete("/api/sites/:id", (c) => {
  const r = db.prepare("DELETE FROM sites WHERE id = ?").run(c.req.param("id"));
  return r.changes ? c.json({ ok: true }) : c.json({ error: "Site introuvable" }, 404);
});

// 1.1 / D3 : état de l'installation d'un site — dernière visite acceptée et refus depuis le redémarrage.
app.get("/api/sites/:id/setup-status", (c) => {
  const s = getSite(c.req.param("id"));
  if (!s) return c.json({ error: "Site introuvable" }, 404);
  const row = db.prepare("SELECT last_hit FROM sites WHERE id = ?").get(s.id) as { last_hit: number | null } | undefined;
  return c.json({ last_hit: row?.last_hit ?? null, refused: refusals(s.id, s.domain) });
});
// C9 : rétention — compte et purge des événements, réservés à l'administrateur (403 pour toute clé).
app.get("/api/sites/:id/events/count", (c) => {
  if (!isAdmin(c)) return c.json({ error: "Réservé à l'administrateur" }, 403);
  const s = getSite(c.req.param("id"));
  if (!s) return c.json({ error: "Site introuvable" }, 404);
  const before = c.req.query("before") ?? "";
  try { return c.json({ before, count: countEventsBefore({ siteId: s.id, before }) }); }
  catch (e) { return c.json({ error: (e as Error).message }, 400); }
});
app.post("/api/sites/:id/purge", async (c) => {
  if (!isAdmin(c)) return c.json({ error: "Réservé à l'administrateur" }, 403);
  const s = getSite(c.req.param("id"));
  if (!s) return c.json({ error: "Site introuvable" }, 404);
  const b = await c.req.json().catch(() => ({}));
  try {
    const r = purgeEventsBefore({ siteId: s.id, before: String(b.before ?? ""), expect: Number(b.expect), dryRun: !!b.dryRun });
    if (!b.dryRun) securityEvent("purge", `${r.deleted} événements`);
    return c.json(r);
  } catch (e) {
    const status = (e as Error & { status?: number }).status ?? 400;
    return c.json({ error: (e as Error).message }, status as 400 | 409);
  }
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
registerPublishers(app);
registerMedia(app);
registerReport(app);
registerProjects(app)
registerConnections(app);
registerStripeOAuth(app);
registerPublisherOAuth(app);
registerSources(app);
startVault();
await loadPlugins();
try { convertGoogleEnv(); } catch (e) { console.error("[google] GOOGLE_SERVICE_ACCOUNT_JSON illisible, non converti :", (e as Error).message); }
activateFromExistingData();
registerOps(app);
registerPortfolio(app);
registerAgents(app);
registerApprovals(app);
registerDashboards(app);
registerModules(app);
registerToday(app);
app.get("/api/jobs", (c) => c.json(jobsStatus()));
registerOutreach(app);

// Toute route /api inconnue répond 404 en JSON (jamais la page HTML de l'interface).
app.all("/api/*", (c) => c.json({ error: "Route introuvable" }, 404));

// ── Interface (build Vite) ──
app.use("/*", serveStatic({ root: "./web/dist" }));
app.get("*", serveStatic({ path: "./web/dist/index.html" }));

// Tâches de fond (ordonnanceur unique, table jobs) : Search Console toutes les 6 h, sauvegarde locale vers 2 h UTC (14 jours gardés)
registerJob("google", { id: "gsc-sync", every: "6h", run: syncAll });
registerJob("projets", { id: "backup", every: "daily@02:00", run: async () => { console.log(`Sauvegarde : ${backup(BACKUP_DIR)}`); } });
startJobs();

const port = Number(process.env.PORT ?? 3030);
// Écoute locale par défaut : sans HOST explicite, rien n'est joignable depuis le réseau.
// Docker exige une écoute interne large pour publier un port (le port publié reste borné à 127.0.0.1 côté hôte).
const inContainer = existsSync("/.dockerenv");
const hostname = process.env.HOST ?? (inContainer ? "0.0.0.0" : "127.0.0.1");
const warning = missing2faWarning({
  inContainer, hostname, envTotp: !!TOTP_SECRET, configured: twofaConfigured(), demo: DEMO,
  quiet: process.env.QUIET_2FA_WARNING === "1",
});
if (warning) console.warn(warning);
const httpServer = serve({ fetch: app.fetch, port, hostname }, () => {
  const address = httpServer.address();
  const actual = typeof address === "object" && address ? address.port : port;
  console.log(`[Searchtide] PORT=${actual}`);
  console.log(`Searchtide sur http://localhost:${actual}`);
});

export { app };
