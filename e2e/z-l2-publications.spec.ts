// L2 phase 1 par l'interface : compte de test, fiche unique, brouillon, publication immédiate avec preuve, validation claire.
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

  // Un compte exige un projet existant (clé du projet).
  expect((await page.request.post("/api/projects", { data: { name: project, crm_key: project } })).ok()).toBe(true);
  await page.reload();

  // 1. Un compte de publication de test pour ce projet (onglet Comptes).
  await page.getByRole("button", { name: "Comptes", exact: true }).click();
  await page.getByLabel("Projet du compte").selectOption(project);
  await page.getByLabel("Réseau du compte").selectOption("x");
  await page.getByLabel("Nom du compte").fill("Compte e2e");
  await page.getByRole("button", { name: "Ajouter", exact: true }).click();
  await expect(page.getByRole("cell", { name: "Compte e2e" })).toBeVisible();

  // 2. Une seule fiche : écrire, joindre un média, programmer.
  await page.getByRole("button", { name: "Calendrier", exact: true }).click();
  await page.getByRole("button", { name: "Nouvelle publication" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Titre (pour vous) *").fill("Annonce L2");
  await dialog.getByRole("combobox", { name: "Projet", exact: true }).selectOption(project);
  await dialog.getByRole("checkbox", { name: /Compte e2e/ }).check();
  await dialog.getByLabel(/^Texte pour Compte e2e/).fill("Bonjour depuis Searchtide");
  await dialog.getByRole("button", { name: "Enregistrer le brouillon" }).click();
  await expect(dialog.getByText("Brouillon enregistré.")).toBeVisible();
  await dialog.getByLabel("Ajouter un média").setInputFiles({ name: "photo.jpg", mimeType: "image/jpeg", buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]) });
  await expect(dialog.getByRole("link", { name: "photo.jpg" })).toBeVisible();
  await dialog.getByRole("button", { name: "Maintenant", exact: true }).click();
  await dialog.getByRole("button", { name: "Publier maintenant" }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: /Annonce L2/ }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByText("Suivi", { exact: true }).click();
  await expect(dialog.getByRole("link", { name: "Voir la preuve" })).toHaveAttribute("href", /^https:\/\/sim\.test\/x\//);
  await dialog.getByRole("button", { name: "Fermer" }).click();

  // 3. La validation par réseau est immédiate et lisible, sans créer de brouillon.
  await page.getByRole("button", { name: "Nouvelle publication" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Titre (pour vous) *").fill("Trop long");
  await dialog.getByRole("combobox", { name: "Projet", exact: true }).selectOption(project);
  await dialog.getByRole("checkbox", { name: /Compte e2e/ }).check();
  await dialog.getByLabel(/^Texte pour Compte e2e/).fill("a".repeat(281));
  await expect(dialog.getByRole("alert")).toContainText("Texte trop long pour x");
  await dialog.getByRole("button", { name: "Maintenant", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Publier maintenant" })).toBeDisabled();
});

test("programmer puis annuler, et publication à vérifier dans À surveiller", async ({ page }) => {
  await login(page);
  await page.goto("/?view=pubs");
  const project = `e2e-pub2-${Date.now().toString(36)}`;
  expect((await page.request.post("/api/projects", { data: { name: project, crm_key: project } })).ok()).toBe(true);
  expect((await page.request.post("/api/pub-accounts", { data: { project, network: "x", label: "Compte e2e 2", mode: "api" } })).ok()).toBe(true);
  await page.reload();

  // Programmer puis annuler depuis la fiche unique.
  await page.getByRole("button", { name: "Nouvelle publication" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Titre (pour vous) *").fill("Programmée e2e");
  await dialog.getByRole("combobox", { name: "Projet", exact: true }).selectOption(project);
  await dialog.getByRole("checkbox", { name: /Compte e2e 2/ }).check();
  await dialog.getByLabel(/^Texte pour Compte e2e 2/).fill("Une publication programmée");
  await dialog.getByRole("button", { name: "Date et heure", exact: true }).click();
  const future = new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10) + "T10:00";
  await dialog.getByLabel("Date et heure").fill(future);
  await dialog.getByRole("button", { name: "Programmer", exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: /Programmée e2e/ }).first().click();
  dialog = page.getByRole("dialog");
  await dialog.getByText("Suivi", { exact: true }).click();
  await expect(dialog.getByText("● Programmée")).toBeVisible();
  await dialog.getByRole("button", { name: "Annuler", exact: true }).click();
  await expect(dialog.getByText("● Annulée")).toBeVisible();
  await dialog.getByRole("button", { name: "Fermer" }).click();

  // Un doute d'envoi remonte dans À surveiller.
  await page.getByRole("button", { name: "Nouvelle publication" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Titre (pour vous) *").fill("À vérifier e2e");
  await dialog.getByRole("combobox", { name: "Projet", exact: true }).selectOption(project);
  await dialog.getByRole("checkbox", { name: /Compte e2e 2/ }).check();
  await dialog.getByLabel(/^Texte pour Compte e2e 2/).fill("[crash] doute d'envoi");
  await dialog.getByRole("button", { name: "Maintenant", exact: true }).click();
  await dialog.getByRole("button", { name: "Publier maintenant" }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: /À surveiller/ }).click();
  await expect(page.getByText("À vérifier e2e")).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "À vérifier e2e" }).getByText("À vérifier", { exact: true })).toBeVisible();
});
