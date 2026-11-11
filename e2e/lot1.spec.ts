// Lot 1 : erreur /api/sites avec réessai, lien d'évitement clavier, texte de connexion selon la configuration.
import { test, expect, type Page } from "@playwright/test";

async function login(page: Page) {
  await page.goto("/");
  await page.locator('input[name="password"]').fill("e2e-mot-de-passe");
  await page.keyboard.press("Enter");
  await page.waitForLoadState("networkidle");
}

test("CA 1.3 : /api/sites en 500 affiche un message et « Réessayer » recharge", async ({ page }) => {
  let fail = true;
  await page.route("**/api/sites", (route) => fail
    ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Base indisponible" }) })
    : route.continue());
  await login(page);
  await expect(page.getByRole("alert").filter({ hasText: "Base indisponible" })).toBeVisible();
  fail = false;
  await page.getByRole("button", { name: "Réessayer" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Base indisponible" })).toHaveCount(0);
});

test("CA E1 : « Aller au contenu » au premier Tab, Entrée place le focus sur main", async ({ page }) => {
  await login(page);
  // Point de départ du focus clavier remis sur le document (pas sur un champ de l'onboarding
  // ni sur le lien d'évitement lui-même).
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Aller au contenu" });
  await expect(skip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("main#contenu")).toBeFocused();
});

test("CA A4 : le texte de connexion suit la configuration (ADMIN_PASSWORD dans les tests)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText(/défini par ADMIN_PASSWORD/)).toBeVisible();
  const cfg = await (await page.request.get("/api/auth-config")).json();
  expect(cfg.passwordGenerated).toBe(false);
  expect(cfg).not.toHaveProperty("password");
});
