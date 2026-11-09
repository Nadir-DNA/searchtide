import { defineConfig } from "@playwright/test";
import { existsSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Serveur réel sur une base temporaire ; les fournisseurs sont simulés dans les tests (page.route), jamais joints.
const db = join(tmpdir(), `searchtide-e2e-${process.pid}.db`);

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
  use: { baseURL: "http://127.0.0.1:3067", locale: "fr-FR", launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? localChromium() } },
  webServer: {
    command: `rm -f ${db}* && DATABASE_PATH=${db} PORT=3067 HOST=127.0.0.1 ADMIN_PASSWORD=e2e-mot-de-passe SECRET=${"e".repeat(40)} API_KEY=e2e-cle node --no-warnings --import ./e2e/fake-providers.ts server/index.ts`,
    url: "http://127.0.0.1:3067/healthz",
    reuseExistingServer: false,
  },
});
