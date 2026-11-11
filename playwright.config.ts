import { defineConfig } from "@playwright/test";
import { existsSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Serveur réel sur une base temporaire ; les fournisseurs sont simulés dans les tests (page.route), jamais joints.
const db = join(tmpdir(), `searchtide-e2e-${process.pid}.db`);
// Port surchargeable : plusieurs agents peuvent lancer l'e2e en parallèle sur cette machine.
const port = Number(process.env.E2E_PORT ?? 3067);

// Chromium déjà présent sur la machine (le plus récent) pour éviter un téléchargement ; sinon Playwright utilise le sien.
function localChromium() {
  const root = join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(root)) return undefined;
  const found = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
    .map((d) => join(root, d, "chrome-linux64", "chrome")).find(existsSync);
  return found;
}

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  workers: 1,
  use: { baseURL: `http://127.0.0.1:${port}`, locale: "fr-FR", launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? localChromium() } },
  projects: [
    { name: "desktop", testIgnore: /mobile\.spec\.ts/ },
    { name: "mobile", testMatch: /mobile\.spec\.ts/, use: { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true } },
  ],
  webServer: {
    command: `rm -f ${db}* && DATABASE_PATH=${db} PORT=${port} HOST=127.0.0.1 RELAY_MOCK=1 RELAY_URL=https://connect.test BROWSER_SANDBOX=0 NODE_ENV=test ADMIN_PASSWORD=e2e-mot-de-passe SECRET=${"e".repeat(40)} API_KEY=e2e-cle node --no-warnings --import ./e2e/fake-providers.ts server/index.ts`,
    url: `http://127.0.0.1:${port}/healthz`,
    reuseExistingServer: false,
  },
});
