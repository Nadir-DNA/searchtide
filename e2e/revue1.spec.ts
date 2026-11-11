// Corrections de la revue du lot 1 : réseau coupé, 401 global, réponses inversées (F1), copie en échec visible.
import { test, expect, type Page } from "@playwright/test";

async function login(page: Page) {
  await page.goto("/");
  await page.locator('input[name="password"]').fill("e2e-mot-de-passe");
  await page.keyboard.press("Enter");
  await page.waitForLoadState("networkidle");
}

const traffic = (visitors: number) => ({
  range: { from: "2026-11-01", to: "2026-11-28" },
  totals: { visitors, pageviews: visitors, ai: 0 },
  previous: { visitors: 0, pageviews: 0, ai: 0 },
  daily: [], channels: [], pages: [], referrers: [], aiReferrers: [], countries: [], devices: [], browsers: [], campaigns: [],
});

test("CA 1.9 : réseau coupé → message clair, pas d'écran vide", async ({ page }) => {
  await login(page);
  await page.route("**/api/sites", (route) => route.abort("failed"));
  await page.reload();
  await expect(page.getByRole("alert").filter({ hasText: "Impossible de joindre l'instance" })).toBeVisible();
});

test("CA 1.9 : un 401 sur n'importe quel appel ramène à la connexion", async ({ page }) => {
  await login(page);
  await page.route("**/api/today", (route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Session expirée" }) }));
  await page.goto("/?view=today");
  await expect(page.getByRole("heading", { name: "Connexion" })).toBeVisible();
});

test("CA 1.9 : plusieurs 401 ne déclenchent qu'un seul retour à la connexion", async ({ page }) => {
  await login(page);
  await page.addInitScript(() => { (window as any).__authEvents = 0; addEventListener("st-auth-expired", () => { (window as any).__authEvents += 1; }); });
  for (const pattern of ["**/api/me", "**/api/sites", "**/api/projects*", "**/api/today"]) {
    await page.route(pattern, (route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Session expirée" }) }));
  }
  await page.reload();
  await expect(page.getByRole("heading", { name: "Connexion" })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__authEvents)).toBe(1);
});

test("CA F1 : deux composants qui lisent la même URL reçoivent tous deux leurs données", async ({ page }) => {
  await login(page);
  await page.evaluate(() => localStorage.setItem("searchtide-demarrage-passe", "1"));
  const a = `dup-a-${Date.now().toString(36)}.test`;
  const b = `dup-b-${Date.now().toString(36)}.test`;
  await page.request.post("/api/sites", { data: { domain: a } });
  await page.request.post("/api/sites", { data: { domain: b } });
  const dash = await (await page.request.post("/api/dashboards", { data: { name: `Doublons ${Date.now().toString(36)}` } })).json();
  const put = await page.request.put(`/api/dashboards/${dash.id}`, { data: { widgets: [{ type: "site", options: { site: a } }, { type: "site", options: { site: b } }] } });
  expect(put.ok()).toBe(true);
  await page.goto(`/?view=page&id=${dash.id}`);
  await expect(page.getByRole("button", { name: a })).toBeVisible();
  await expect(page.getByRole("button", { name: b })).toBeVisible();
});

test("CA F1 : deux réponses dans l'ordre inverse, seule la dernière URL s'affiche", async ({ page }) => {
  await login(page);
  await page.evaluate(() => localStorage.setItem("searchtide-demarrage-passe", "1"));
  const domain = `f1-${Date.now().toString(36)}.test`;
  await page.request.post("/api/sites", { data: { domain } });
  await page.route("**/api/sites/*/traffic*", async (route) => {
    const days = new URL(route.request().url()).searchParams.get("days");
    if (days === "7") { await new Promise((r) => setTimeout(r, 500)); return route.fulfill({ json: traffic(700) }); }
    await new Promise((r) => setTimeout(r, 20));
    return route.fulfill({ json: traffic(2800) });
  });
  await page.goto(`/?site=${domain}`);
  await expect(page.getByText(/2.?800/).first()).toBeVisible();
  await page.getByRole("button", { name: "7 j" }).click();
  await page.getByRole("button", { name: "28 j" }).click();
  await expect(page.getByText(/2.?800/).first()).toBeVisible();
  await expect(page.getByText(/^700$/)).toHaveCount(0);
});

test("CA 1.5 : copie en échec → message visible", async ({ page }) => {
  await login(page);
  await page.evaluate(() => localStorage.setItem("searchtide-demarrage-passe", "1"));
  const domain = `copie-${Date.now().toString(36)}.test`;
  await page.request.post("/api/sites", { data: { domain } });
  await page.goto(`/?site=${domain}&tab=setup`);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    document.execCommand = () => false;
  });
  await page.getByRole("button", { name: "Copier" }).first().click();
  await expect(page.getByRole("status").filter({ hasText: "Copie impossible" })).toBeVisible();
});
