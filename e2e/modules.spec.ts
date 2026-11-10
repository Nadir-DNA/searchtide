// Modules : une instance neuve n'affiche aucun chiffre pour une source absente, mais propose de l'activer.
// Vrai serveur, vraie base ; aucun fournisseur joint.
import { test, expect, type Page } from "@playwright/test";

async function login(page: Page) {
  await page.goto("/");
  await page.locator('input[name="password"]').fill("e2e-mot-de-passe");
  await page.keyboard.press("Enter");
  await page.waitForLoadState("networkidle");
}

test("instance neuve : aucun montant ni clic affiché pour une source absente", async ({ page }) => {
  await login(page);
  await page.evaluate(() => localStorage.setItem("searchtide-demarrage-passe", "1"));
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Chiffres du portefeuille" })).toBeVisible();
  await expect(page.getByText("0 €")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Activer Stripe/ }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Activer Contacts/ }).first()).toBeVisible();
});
