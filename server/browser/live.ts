// B2 : affichage intégré sécurisé. Un ticket à usage unique (60 s) ouvre un flux SSE d'images JPEG ;
// les entrées (souris, molette, clavier, texte) arrivent par POST et sont relayées sans être stockées.
// Une seule vue à la fois, administrateur seul, fermeture après 10 minutes d'inactivité.
// Aucune furtivité : mêmes arguments de lancement que le pool, aucun profil sur disque.
import { randomBytes } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "playwright-core";
import { db } from "../db.ts";
import { assertAllowedUrl, chromiumExecutable, LAUNCH_ARGS, sandboxEnabled } from "./pool.ts";
import { startFilterProxy, type FilterProxy } from "./netguard.ts";
import { open as openVault, seal } from "../vault.ts";

db.exec(`CREATE TABLE IF NOT EXISTS browser_sessions (
  account_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, sealed TEXT NOT NULL, updated_at INTEGER NOT NULL
)`);

export const TICKET_TTL = 60_000;
export const IDLE_MS = 10 * 60_000;
const MAX_TEXT = 1000;
const MAX_EVENTS_PER_SECOND = 60;

export type InputEvent =
  | { type: "move"; x: number; y: number }
  | { type: "click"; x: number; y: number; button?: "left" | "right" }
  | { type: "wheel"; deltaY: number; x?: number; y?: number }
  | { type: "key"; key: string }
  | { type: "text"; text: string };

type Live = {
  token: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  cdp: CDPSession;
  subscribers: Set<(jpeg: string) => void>;
  lastActivity: number;
  events: number[];
  connected: boolean;
  closed: boolean;
  issuedAt: number;
  used: boolean;
  proxy: FilterProxy;
};

let current: Live | null = null;
let closing = false;
let idleTimer: NodeJS.Timeout | null = null;

const token = () => randomBytes(32).toString("base64url");

export const liveStatus = () => ({ open: !!current, viewers: current?.subscribers.size ?? 0 });

/** Valide une entrée : schéma strict, valeurs bornées ; tout le reste est refusé. */
export function validateInput(raw: unknown): InputEvent {
  if (!raw || typeof raw !== "object") throw new Error("Entrée invalide");
  const e = raw as Record<string, unknown>;
  const num = (v: unknown, min: number, max: number, label: string) => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw new Error(`${label} invalide`);
    return v;
  };
  if (e.type === "move") return { type: "move", x: num(e.x, 0, 8000, "x"), y: num(e.y, 0, 8000, "y") };
  if (e.type === "click") {
    const button = e.button === "right" ? "right" : "left";
    return { type: "click", x: num(e.x, 0, 8000, "x"), y: num(e.y, 0, 8000, "y"), button };
  }
  if (e.type === "wheel") return { type: "wheel", deltaY: num(e.deltaY, -5000, 5000, "deltaY"), ...(e.x != null ? { x: num(e.x, 0, 8000, "x") } : {}), ...(e.y != null ? { y: num(e.y, 0, 8000, "y") } : {}) };
  if (e.type === "key") {
    if (typeof e.key !== "string" || !e.key || e.key.length > 20) throw new Error("Touche invalide");
    return { type: "key", key: e.key };
  }
  if (e.type === "text") {
    if (typeof e.text !== "string" || e.text.length > MAX_TEXT) throw new Error(`Texte invalide (${MAX_TEXT} caractères au plus)`);
    return { type: "text", text: e.text };
  }
  throw new Error("Type d'entrée inconnu");
}

/** Ouvre une vue : le ticket renvoyé ne sert qu'une fois, pour le flux SSE. */
export async function startLive(o: { url: string; fixturePort: number; sandbox?: boolean; chromiumSandbox?: boolean; lookup?: (host: string) => Promise<string[]> }): Promise<{ ticket: string; expiresAt: number }> {
  if (current || closing) throw new Error("Une vue est déjà ouverte : fermez-la d'abord");
  const sandbox = o.sandbox ?? sandboxEnabled();
  assertAllowedUrl(o.url, { sandbox, fixturePort: o.fixturePort });
  // Tout le trafic passe par le proxy filtrant (redirections, DNS, sous-ressources) : voir netguard.ts.
  const proxy = await startFilterProxy({ sandbox, fixture: { port: o.fixturePort }, lookup: o.lookup });
  const browser = await chromium.launch({ headless: true, chromiumSandbox: o.chromiumSandbox ?? sandbox, executablePath: chromiumExecutable(), args: [...LAUNCH_ARGS],
    proxy: { server: `http://127.0.0.1:${proxy.port}`, bypass: "<-loopback>", username: proxy.auth.username, password: proxy.auth.password } }).catch(async (e) => { await proxy.close(); throw e; });
  try {
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block", permissions: [] });
    await context.route("**/*", async (route) => {
      try { assertAllowedUrl(route.request().url(), { sandbox, fixturePort: o.fixturePort }); await route.continue(); }
      catch { await route.abort("blockedbyclient").catch(() => { /* déjà terminée */ }); }
    });
    const page = await context.newPage();
    page.on("download", (d) => d.cancel().catch(() => { /* refusé */ }));
    await page.goto(o.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const cdp = await context.newCDPSession(page);
    const live: Live = { token: token(), browser, context, page, cdp, subscribers: new Set(), lastActivity: Date.now(), events: [], connected: false, closed: false, issuedAt: Date.now(), used: false, proxy };
    cdp.on("Page.screencastFrame", async (f: { data: string; sessionId: number }) => {
      await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => { /* vue fermée */ });
      for (const send of live.subscribers) send(f.data);
    });
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, everyNthFrame: 1 });
    current = live;
    idleTimer = setInterval(() => {
      if (current && Date.now() - current.lastActivity > IDLE_MS) void closeLive();
    }, 30_000);
    idleTimer.unref();
    return { ticket: live.token, expiresAt: Date.now() + TICKET_TTL };
  } catch (e) { await browser.close().catch(() => { /* déjà fermé */ }); await proxy.close(); throw e; }
}

/** Flux : le ticket est à usage unique, une seule vue à la fois. */
export function subscribe(ticket: string, send: (jpeg: string) => void, now = Date.now()): () => void {
  const live = current;
  if (!live || live.closed) throw new Error("Vue absente ou fermée");
  if (live.token !== ticket) throw new Error("Ticket invalide");
  if (live.connected) throw new Error("Une vue est déjà connectée");
  // B2-D2 : un ticket jamais utilisé expire après 60 s ; la vue reste ouverte et se ferme à l'inactivité.
  if (!live.used && now - live.issuedAt > TICKET_TTL) throw new Error("Ticket expiré : ouvrez une nouvelle vue");
  live.connected = true;
  live.used = true;
  live.lastActivity = Date.now();
  live.subscribers.add(send);
  // Première image immédiate : le screencast ne renvoie ensuite que sur changement.
  void live.cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 60 })
    .then((r: { data?: string }) => { if (r.data) send(r.data); })
    .catch(() => { /* vue fermée */ });
  // B2-D1 : le désabonnement libère la place : le même ticket peut se reconnecter (réseau coupé, onglet rechargé).
  return () => { live.subscribers.delete(send); live.connected = false; };
}

/** Relaie une entrée validée ; les frappes ne sont ni journalisées ni conservées. */
export async function sendInput(ticket: string, raw: unknown, now = Date.now()): Promise<void> {
  const live = current;
  if (!live || live.closed || live.token !== ticket) throw new Error("Vue absente ou fermée");
  // B2-D2 : même expiration que pour le flux : un ticket jamais utilisé ne sert pas non plus aux entrées.
  if (!live.used && now - live.issuedAt > TICKET_TTL) throw new Error("Ticket expiré : ouvrez une nouvelle vue");
  live.events = live.events.filter((t) => now - t < 1000);
  if (live.events.length >= MAX_EVENTS_PER_SECOND) throw new Error("Trop d'entrées : réessayez dans une seconde");
  live.events.push(now);
  live.lastActivity = now;
  const e = validateInput(raw);
  const cdp = live.cdp;
  if (e.type === "move") await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: e.x, y: e.y });
  else if (e.type === "click") {
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: e.x, y: e.y, button: e.button ?? "left", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: e.x, y: e.y, button: e.button ?? "left", clickCount: 1 });
  } else if (e.type === "wheel") await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: e.x ?? 0, y: e.y ?? 0, deltaY: e.deltaY });
  else if (e.type === "key") {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: e.key });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: e.key });
  } else await cdp.send("Input.insertText", { text: e.text });
}

/** Ferme la vue. `save` scelle l'état de session (cookies + IndexedDB) dans le coffre, jamais sur disque. */
export async function closeLive(save?: { accountId: string; projectId: string }): Promise<{ saved: boolean }> {
  const live = current;
  if (!live) return { saved: false };
  closing = true;
  current = null;
  live.closed = true;
  if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
  live.subscribers.clear();
  let saved = false;
  try {
    if (save) {
      const state = await live.context.storageState({ indexedDB: true });
      saveBrowserSession(save.accountId, save.projectId, state as unknown as Record<string, unknown>);
      saved = true;
    }
  } finally {
    // Fermer même si le scellement échoue : jamais de navigateur orphelin.
    await live.cdp.send("Page.stopScreencast").catch(() => { /* déjà arrêté */ });
    await live.browser.close().catch(() => { /* déjà fermé */ });
    await live.proxy.close();
    closing = false;
  }
  return { saved };
}

export function saveBrowserSession(accountId: string, projectId: string, state: Record<string, unknown>) {
  const sealed = seal(state); // refuse si SECRET invalide
  db.prepare(`INSERT INTO browser_sessions (account_id, project_id, sealed, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET project_id = excluded.project_id, sealed = excluded.sealed, updated_at = excluded.updated_at`)
    .run(accountId, projectId, sealed, Date.now());
}

/** État de session rechargé en mémoire ; jamais renvoyé par l'API ni écrit sur disque. */
export function openBrowserSession(accountId: string): Record<string, unknown> | null {
  const r = db.prepare("SELECT sealed FROM browser_sessions WHERE account_id = ?").get(accountId) as { sealed: string } | undefined;
  return r ? openVault(r.sealed) : null;
}

/** Révocation : l'état scellé est effacé, la prochaine vue part sans cookie. */
export function revokeBrowserSession(accountId: string) {
  return db.prepare("DELETE FROM browser_sessions WHERE account_id = ?").run(accountId).changes > 0;
}

/** Utilisé uniquement par les tests et l'interface locale : ne renvoie jamais l'état. */
export const livePage = () => current?.page ?? null;
