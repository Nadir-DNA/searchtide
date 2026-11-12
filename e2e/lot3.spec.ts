// Lot 3 : palette de commandes et aide clavier (1.7/B9), tableau empilé sous 640 px (B5).
import { test, expect, type Page } from "@playwright/test";

async function login(page: Page) {
  await page.goto("/");
  await page.locator('input[name="password"]').fill("e2e-mot-de-passe");
  await page.keyboard.press("Enter");
  await page.waitForLoadState("networkidle");
}

test("CA 1.7/B9 : Ctrl+K ouvre la palette, filtre, Entrée navigue ; ? ouvre l'aide ; Échap ferme", async ({ page }) => {
  await login(page);
  await page.evaluate(() => localStorage.setItem("searchtide-demarrage-passe", "1"));
  await page.goto("/?view=today");
  await page.waitForLoadState("networkidle");
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Palette de commandes" });
  await expect(palette).toBeVisible();
  await palette.getByLabel("Rechercher un site, un projet ou une vue").fill("Réglages");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Réglages", level: 1 })).toBeVisible();
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("INPUT");

  await page.keyboard.press("?");
  const help = page.getByRole("dialog", { name: "Raccourcis clavier" });
  await expect(help).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(help).toHaveCount(0);

  // Dans un champ de saisie, « / » écrit un caractère et n'ouvre pas la palette.
  await page.goto("/?view=agents");
  const field = page.locator('input[name="name"]').first();
  await field.click();
  await page.keyboard.type("/");
  await expect(palette).toHaveCount(0);
  await expect(field).toHaveValue("/");
});

test("CA fusion : un chunk introuvable affiche « Impossible de charger cet écran » et Recharger", async ({ page }) => {
  await login(page);
  await page.evaluate(() => localStorage.setItem("searchtide-demarrage-passe", "1"));
  await page.route("**/assets/settings-*.js", (route) => route.abort("failed"));
  await page.goto("/?view=settings");
  await expect(page.getByRole("alert").filter({ hasText: "Impossible de charger cet écran" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Recharger" })).toBeVisible();
});

test("CA C7 : une cible non numérique n'efface pas l'objectif", async ({ page }) => {
  await login(page);
  await page.evaluate(() => localStorage.setItem("searchtide-demarrage-passe", "1"));
  const p = await (await page.request.post("/api/projects", { data: { name: `Objectif ${Date.now().toString(36)}` } })).json();
  await page.request.post(`/api/projects/${p.id}/indicators`, { data: { label: "Ventes", mode: "total", source: "manual", goal: 10, goal_period: "month" } });
  await page.goto(`/?view=project&id=${p.id}`);
  await page.getByRole("button", { name: "Modifier" }).first().click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByLabel("Nouvelle cible").fill("abc");
  await expect(dialog.getByRole("alert")).toContainText("nombre supérieur à 0");
  await expect(dialog.getByRole("button", { name: "Enregistrer" })).toBeDisabled();
  await page.keyboard.press("Escape");
  const after = await (await page.request.get(`/api/projects/${p.id}`)).json();
  expect(after.indicators[0].goal.target).toBe(10);
});

test.describe("375 px", () => {
  test.use({ viewport: { width: 375, height: 812 } });
  test("CA B5 : un tableau devient une fiche étiquette/valeur, sans débordement", async ({ page }) => {
    await login(page);
    await page.request.post("/api/agents", { data: { name: `mobile-${Date.now().toString(36)}` } });
    await page.goto("/?view=agents");
    const table = page.locator("table.st-table").first();
    await expect(table).toBeVisible();
    await expect(table.locator("td[data-label]").first()).toBeVisible();
    expect(await page.evaluate(() => getComputedStyle(document.querySelector("table.st-table thead")!).display)).toBe("none");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
