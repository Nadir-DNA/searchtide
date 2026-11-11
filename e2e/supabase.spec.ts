// CA40/CA43/CA45 : connexion Supabase simulée, indice sans secret, test et révocation à 375 px.
import { test, expect, type Page } from "@playwright/test";
test.use({ viewport: { width: 375, height: 812 } });
const noHScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
async function login(page: Page) {
  await page.goto("/");
  await page.locator('input[name="password"]').fill("e2e-mot-de-passe");
  await page.keyboard.press("Enter");
  await page.waitForLoadState("networkidle");
}
test("CA40/CA43/CA45 : Supabase se connecte, affiche un indice sans secret, se révoque au clavier", async ({ page }) => {
  await login(page);
  await page.goto("/?view=connections");
  await page.getByRole("button", { name: /^Supabase :/ }).click();
  const d = page.getByRole("dialog", { name: "Supabase" });
  await d.getByLabel(/Adresse de connexion/).fill("postgres://searchtide_ro.demo@pooler.exemple.test:5432/postgres");
  await d.getByRole("button", { name: "Tester et enregistrer" }).click();
  await d.getByRole("status").filter({ hasText: "Connecté" }).waitFor();
  await expect(d.getByText(/projet demo/).first()).toBeVisible();
  await expect(d.getByText(/searchtide_ro@demo/)).toBeVisible();
  expect(await noHScroll(page)).toBe(true);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^Supabase :/ }).click();
  const li = page.getByRole("listitem").filter({ hasText: "searchtide_ro@demo" });
  await li.getByRole("button", { name: "Retirer" }).click();
  const confirm = page.getByRole("dialog", { name: "Supabase" }).getByRole("alertdialog");
  await confirm.getByRole("button", { name: "Retirer définitivement" }).click();
  await expect(page.getByRole("status")).toContainText("est retiré", { timeout: 10_000 });
});
