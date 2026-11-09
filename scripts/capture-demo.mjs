// Capture la démonstration pour le README (T29). Usage : node scripts/capture-demo.mjs [url]
// Suppose une instance DEMO=1 qui tourne (données fictives générées automatiquement).
import { chromium } from "@playwright/test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const url = (process.argv[2] ?? process.env.DEMO_URL ?? "http://127.0.0.1:3030").replace(/\/$/, "");
const root = join(homedir(), ".cache", "ms-playwright");
const local = existsSync(root)
  ? readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
      .map((d) => join(root, d, "chrome-linux64", "chrome")).find(existsSync)
  : undefined;

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? local });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: "fr-FR", colorScheme: "dark"   // thème par défaut, celui des captures livrées (Q-N10 = A) });
try {
  await page.goto(`${url}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  await page.screenshot({ path: "docs/demo.png", fullPage: true });
  await page.goto(`${url}/?view=portfolio`, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await page.screenshot({ path: "docs/demo-portefeuille.png", fullPage: true });
  console.log("Captures écrites : docs/demo.png, docs/demo-portefeuille.png");
} finally { await browser.close(); }
