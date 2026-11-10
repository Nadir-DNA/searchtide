// CA32/CA52 (relais simulé) : consentement explicite, libellé (test), repli clé limitée, 375 px.
import { test, expect, type Page } from "@playwright/test";
test.use({ viewport: { width: 375, height: 812 } });
const noHScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
async function login(page: Page) {
  await page.goto("/");
  await page.locator('input[name="password"]').fill("e2e-mot-de-passe");
  await page.keyboard.press("Enter");
  await page.waitForLoadState("networkidle");
}
test("CA32/CA52 : le bouton reste inactif sans consentement, puis propose la clé limitée au clavier", async ({ page }) => {
  await login(page);
  await page.goto("/?view=connections");
  await expect(page.getByRole("heading", { name: "Connexion avec Stripe" })).toBeVisible();
  const go = page.getByRole("button", { name: "Continuer vers Stripe (test)" });
  await expect(go).toBeDisabled();
  const consent = page.getByRole("checkbox", { name: /J'autorise Searchtide Connect/ });
  await consent.focus(); await page.keyboard.press("Space");
  await expect(go).toBeEnabled();
  await expect(page.getByRole("link", { name: "Politique de confidentialité" })).toHaveAttribute("href", "https://connect.test/privacy");
  const key = page.getByRole("button", { name: "Utiliser une clé limitée" });
  await key.focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Stripe" })).toBeVisible();
  expect(await noHScroll(page)).toBe(true);
});

test("CA51 : relais indisponible → message, bouton désactivé, clé limitée utilisable", async ({ page }) => {
  await page.route("**/api/stripe-oauth/status", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ enabled: true, ok: false, mode: null, error: "unreachable", url: "https://connect.test" }) }));
  await login(page);
  await page.goto("/?view=connections");
  await expect(page.getByRole("alert")).toContainText("Searchtide Connect est indisponible");
  await expect(page.getByRole("button", { name: /Continuer vers Stripe/ })).toBeDisabled();
  const key = page.getByRole("button", { name: "Utiliser une clé limitée" });
  await key.focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Stripe" })).toBeVisible();
  expect(await noHScroll(page)).toBe(true);
});
