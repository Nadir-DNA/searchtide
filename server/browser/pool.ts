// B1 : moteur navigateur local. Chromium sans fenêtre, un navigateur par exécution, une exécution à la fois.
// Aucun port de contrôle (Playwright utilise un pipe), aucun profil sur disque, aucune furtivité :
// l'agent utilisateur et navigator.webdriver de Chromium restent intacts.
import { chromium, type Browser, type Page } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { exoticNumeric, isForbiddenName, startFilterProxy } from "./netguard.ts";

type Row = Record<string, unknown>;

/** Chromium fourni par la machine (CHROMIUM_PATH) ou le plus récent du cache Playwright ; rien n'est téléchargé. */
export function chromiumExecutable(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.CHROMIUM_PATH) return env.CHROMIUM_PATH;
  const root = join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(root)) return undefined;
  return readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
    .map((d) => [join(root, d, "chrome-linux64", "chrome"), join(root, d, "chrome-linux", "chrome")].find(existsSync))
    .find(Boolean);
}

/** Bac à sable actif par défaut ; `BROWSER_SANDBOX=0` n'est admis que pour les pages de test locales. */
export const sandboxEnabled = (env: NodeJS.ProcessEnv = process.env) => env.BROWSER_SANDBOX !== "0";

/** Arguments fixes. Aucun `--remote-debugging-port`, aucun masquage d'empreinte. */
export const LAUNCH_ARGS = ["--disable-extensions"] as const;
const MAX_RUN_MS = Number(process.env.BROWSER_RUN_MS) || 5 * 60_000;

const isLoopback = (host: string) => host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
/**
 * Hôte autorisé. Sans bac à sable : uniquement les pages de test servies sur la boucle locale et le port prévu.
 * Avec bac à sable : sites publics seulement, adresses privées et métadonnées de nuage refusées.
 * Premier contrôle, pour un message clair : la protection réelle est le proxy filtrant (netguard.ts) qui voit aussi les redirections.
 */
export function assertAllowedUrl(raw: string, o: { sandbox: boolean; fixturePort: number }) {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error("Adresse invalide"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Protocole refusé : http ou https seulement");
  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  const fixture = isLoopback(u.hostname) && port === o.fixturePort;
  if (fixture) return;
  if (!o.sandbox) throw new Error("Bac à sable inactif : navigation limitée aux pages de test locales");
  if (isForbiddenName(u.hostname) || exoticNumeric(u.hostname)) throw new Error("Adresse privée, boucle locale ou métadonnées de nuage refusées");
}

/** Une seule exécution à la fois : le navigateur est en série (réglable plus tard, jamais deux fois le même compte). */
let tail: Promise<unknown> = Promise.resolve();
export const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = tail.then(fn, fn);
  tail = next.catch(() => {});
  return next;
};

/** Compteur d'exécutions simultanées : la valeur ne doit jamais dépasser 1. */
export const runs = { active: 0, max: 0 };

async function withTimeout<T>(p: Promise<T>, ms: number, stop: () => Promise<void>): Promise<T> {
  p.catch(() => { /* l'arrêt forcé rejette la tâche : évite un rejet non géré */ });
  let timer: NodeJS.Timeout;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Rejeter d'abord : la fermeture peut faire échouer la tâche avec un message moins clair.
      reject(new Error(`Délai maximal dépassé (${Math.round(ms / 1000)} s) : navigateur arrêté`));
      void stop().catch(() => { /* déjà fermé */ });
    }, ms);
  });
  try { return await Promise.race([p, limit]); } finally { clearTimeout(timer!); }
}

export type PageRun = { fixturePort: number; sandbox?: boolean; timeoutMs?: number; lookup?: (host: string) => Promise<string[]>; chromiumSandbox?: boolean };

/**
 * Ouvre une page de test dans un contexte neuf, exécute `fn`, ferme tout.
 * Aucune session n'est chargée ici (B1) : chaque exécution part sans cookie.
 */
export async function withPage<T>(url: string, fn: (page: Page) => Promise<T>, o: PageRun): Promise<T> {
  const sandbox = o.sandbox ?? sandboxEnabled();
  assertAllowedUrl(url, { sandbox, fixturePort: o.fixturePort });
  return serial(async () => {
    runs.active += 1;
    runs.max = Math.max(runs.max, runs.active);
    let browser: Browser | null = null;
    const proxy = await startFilterProxy({ sandbox, fixture: { port: o.fixturePort }, lookup: o.lookup });
    try {
      // Tout le trafic (boucle locale comprise) passe par le proxy filtrant : redirections, sous-ressources, DNS.
      browser = await chromium.launch({ headless: true, chromiumSandbox: o.chromiumSandbox ?? sandbox, executablePath: chromiumExecutable(), args: [...LAUNCH_ARGS],
        proxy: { server: `http://127.0.0.1:${proxy.port}`, bypass: "<-loopback>", username: proxy.auth.username, password: proxy.auth.password } });
      const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block", permissions: [] });
      // Chaque requête (y compris sous-ressource) repasse par le même contrôle d'hôte.
      await context.route("**/*", async (route) => {
        try { assertAllowedUrl(route.request().url(), { sandbox, fixturePort: o.fixturePort }); await route.continue(); }
        catch { await route.abort("blockedbyclient").catch(() => { /* requête déjà terminée */ }); }
      });
      const page = await context.newPage();
      page.on("download", (d) => d.cancel().catch(() => { /* téléchargement refusé */ }));
      page.on("popup", (p) => p.close().catch(() => { /* fenêtre non sollicitée fermée */ }));
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: o.timeoutMs ?? MAX_RUN_MS });
      return await withTimeout(fn(page), o.timeoutMs ?? MAX_RUN_MS, async () => { await browser?.close(); });
    } finally {
      await browser?.close().catch(() => { /* processus déjà terminé */ });
      await proxy.close();
      runs.active -= 1;
    }
  });
}

/** Ce que la page factice peut lire sur l'environnement du navigateur (test de non-furtivité). */
export async function browserFingerprint(page: Page): Promise<Row> {
  return page.evaluate(() => ({ ua: navigator.userAgent, webdriver: (navigator as unknown as { webdriver?: boolean }).webdriver ?? false }));
}
