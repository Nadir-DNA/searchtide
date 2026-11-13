// 1.4 : parcours complet de la double authentification (configuration, connexion avec code de secours, désactivation).
//Nommé pour passer en dernier : la 2FA est activée puis désactivée dans le même test sur la base e2e partagée.
import { test, expect } from "@playwright/test";

const PASSWORD = "e2e-mot-de-passe";

test("CA 1.4 : activer la 2FA, se reconnecter avec un code de secours, puis la désactiver", async ({ page }) => {
  await page.goto("/");
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.keyboard.press("Enter");
  await page.waitForLoadState("networkidle");

  await page.goto("/?view=settings");
  await page.getByRole("button", { name: "Configurer" }).click();
  const secretLine = page.getByText(/Clé à saisir à la main/);
  await expect(secretLine).toBeVisible();
  const secret = (await secretLine.textContent())!.split(":").pop()!.trim();
  const { totp } = await import("../server/security.ts");
  await page.getByLabel("Code à 6 chiffres").fill(totp(secret));
  await page.getByRole("button", { name: "Activer" }).click();
  await expect(page.getByText(/Codes de secours/)).toBeVisible();
  const backups = (await page.locator(".bg-positive-bg ul.font-mono li").allTextContents()).map((x) => x.trim());
  expect(backups[0]).toMatch(/^[0-9A-F]{10}$/);
  const backup = backups[0];
  const disableCode = backups[1];

  // La connexion suivante exige un code ; le code de secours est accepté une fois.
  await page.getByRole("button", { name: "Plus", exact: true }).click();
  await page.getByRole("button", { name: "Déconnexion" }).click();
  await expect(page.getByRole("heading", { name: "Connexion" })).toBeVisible();
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('input[name="code"]').fill(backup);
  await page.keyboard.press("Enter");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("navigation", { name: "Projets" })).toBeVisible();

  // Désactivation : mot de passe + code courant.
  await page.goto("/?view=settings");
  await page.locator("summary", { hasText: "Désactiver" }).click();
  await page.getByLabel("Mot de passe pour désactiver").fill(PASSWORD);
  await page.getByLabel("Code pour désactiver").fill(disableCode);
  await page.getByRole("button", { name: "Désactiver" }).click();
  await expect(page.getByText("Double authentification désactivée.")).toBeVisible();
});
