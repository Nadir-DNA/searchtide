// L2 phase 1 par l'interface : compte factice, brouillon, publication immédiate avec preuve, validation claire.
import { test, expect, type Page } from "@playwright/test";

async function login(page: Page) {
  await page.goto("/");
  await page.locator('input[name="password"]').fill("e2e-mot-de-passe");
  await page.keyboard.press("Enter");
  await page.waitForLoadState("networkidle");
}

test("L2 : compte, brouillon, publication immédiate avec preuve, texte trop long refusé", async ({ page }) => {
  await login(page);
  await page.goto("/?view=pubs");
  const project = `e2e-pub-${Date.now().toString(36)}`;

  // 1. Un compte de publication factice pour ce projet.
  await page.getByLabel("Projet du compte").fill(project);
  await page.getByLabel("Réseau du compte").selectOption("x");
  await page.getByLabel("Nom du compte").fill("Compte e2e");
  await page.getByRole("button", { name: "Ajouter", exact: true }).click();
  await expect(page.getByRole("cell", { name: "Compte e2e" })).toBeVisible();

  // 2. Brouillon puis publication immédiate.
  await page.getByRole("button", { name: "Nouvelle publication" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Titre *").fill("Annonce L2");
  await dialog.getByLabel("Projet").fill(project);
  await dialog.getByLabel("Réseau").fill("x");
  await dialog.getByLabel(/^Texte/).fill("Bonjour depuis Searchtide");
  await dialog.getByLabel("Compte de publication").selectOption({ label: "Compte e2e (x)" });
  await dialog.getByRole("button", { name: "Créer le brouillon" }).click();
  await expect(dialog.getByText("● Brouillon")).toBeVisible();
  await dialog.getByLabel("Ajouter un média").setInputFiles({ name: "photo.jpg", mimeType: "image/jpeg", buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]) });
  await expect(dialog.getByRole("link", { name: "photo.jpg" })).toBeVisible();
  await dialog.getByRole("button", { name: "Publier maintenant" }).click();
  await expect(dialog.getByText("● Publié")).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Voir la preuve" })).toHaveAttribute("href", /^https:\/\/sim\.test\/x\//);
  await dialog.getByRole("button", { name: "Fermer" }).click();

  // 3. La validation par réseau est immédiate et lisible.
  await page.getByRole("button", { name: "Nouvelle publication" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Titre *").fill("Trop long");
  await dialog.getByLabel("Projet").fill(project);
  await dialog.getByLabel("Réseau").fill("x");
  await dialog.getByLabel(/^Texte/).fill("a".repeat(281));
  await dialog.getByLabel("Compte de publication").selectOption({ label: "Compte e2e (x)" });
  await dialog.getByRole("button", { name: "Créer le brouillon" }).click();
  await dialog.getByRole("button", { name: "Publier maintenant" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Texte trop long pour x");
  await expect(dialog.getByText("● Brouillon")).toBeVisible();
});
