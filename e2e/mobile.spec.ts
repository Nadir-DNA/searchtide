// F5 : projet Playwright mobile 375 px, deux scénarios (menu et Installation), sans débordement horizontal.
import { test, expect, type Page } from "@playwright/test";

const noHScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

async function login(page: Page) {
  await page.goto("/");
  await page.locator('input[name="password"]').fill("e2e-mot-de-passe");
  await page.keyboard.press("Enter");
  await page.waitForLoadState("networkidle");
}

test("mobile 375 px : le menu s'ouvre et reste dans l'écran", async ({ page }) => {
  await login(page);
  await page.evaluate(() => localStorage.setItem("searchtide-demarrage-passe", "1"));
  await page.goto("/?view=today");
  await expect(page.getByRole("navigation", { name: "Navigation mobile" })).toBeVisible();
  await page.getByRole("navigation", { name: "Navigation mobile" }).getByRole("button", { name: "Plus" }).click();
  await expect(page.getByRole("dialog", { name: "Menu" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Fermer" })).toBeVisible();
  expect(await noHScroll(page)).toBe(true);
});

test("mobile 375 px : l'onglet Installation affiche le script sans débordement", async ({ page }) => {
  await login(page);
  await page.evaluate(() => localStorage.setItem("searchtide-demarrage-passe", "1"));
  const domain = `mobile-${Date.now().toString(36)}.test`;
  await page.request.post("/api/sites", { data: { domain } });
  await page.goto(`/?site=${domain}&tab=setup`);
  await expect(page.getByRole("heading", { name: "Script de suivi" })).toBeVisible();
  await expect(page.getByText(`data-site="${domain}"`)).toBeVisible();
  expect(await noHScroll(page)).toBe(true);
});
