// B5 / CA38 : bouton « Copier » sur l'adresse du compte de service Google, à 0 propriété, au clavier, à 375 px.
import { test, expect, type Page } from "@playwright/test";
import { GOOGLE_JSON } from "../server/connectors/fixtures.ts";

const ZERO_EMAIL = "zero-recette@projet-demo.iam.gserviceaccount.com";
const zeroJson = JSON.stringify({ ...JSON.parse(GOOGLE_JSON), client_email: ZERO_EMAIL });

test.use({ viewport: { width: 375, height: 812 }, permissions: ["clipboard-read", "clipboard-write"] });

async function login(page: Page) {
  await page.goto("/");
  await page.locator('input[name="password"]').fill("e2e-mot-de-passe");
  await page.keyboard.press("Enter");
  await page.waitForLoadState("networkidle");
}

test("CA38 : Copier l'adresse du compte de service (0 propriété), au clavier, avec annonce « Copié »", async ({ page }) => {
  await login(page);
  await page.goto("/?view=connections");
  await page.getByRole("button", { name: /^Google :/ }).click();
  const dialog = page.getByRole("dialog", { name: "Google" });
  await dialog.getByLabel(/Clé du compte de service/).fill(zeroJson);
  await dialog.getByRole("button", { name: "Tester et enregistrer" }).click();
  await dialog.getByRole("status").filter({ hasText: "Connecté" }).waitFor({ timeout: 30_000 });
  await expect(dialog.getByText(/Aucune propriété visible/)).toBeVisible();
  await expect(dialog.getByText(ZERO_EMAIL).first()).toBeVisible();

  const copy = dialog.getByRole("button", { name: "Copier" }).first();
  await copy.focus();
  await expect(copy).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("status").filter({ hasText: "Copié" }).first()).toHaveText(/Copié/);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe(ZERO_EMAIL);

  // Repli sans API presse-papiers : la copie passe par un champ temporaire, sans clic sans effet.
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true }));
  await copy.focus(); await page.keyboard.press("Enter");
  await expect(dialog.getByRole("status").filter({ hasText: "Copié" }).first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
