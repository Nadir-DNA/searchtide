// Un calendrier et des comptes par projet : onglet Publications du projet, sélecteur de projet sur la page Publications.
import { test, expect, type Page } from "@playwright/test";

async function login(page: Page) {
  await page.goto("/");
  await page.locator('input[name="password"]').fill("e2e-mot-de-passe");
  await page.keyboard.press("Enter");
  await page.waitForLoadState("networkidle");
}

test("chaque projet a son calendrier et ses comptes", async ({ page }) => {
  await login(page);
  const u = Date.now().toString(36);
  const a = await (await page.request.post("/api/projects", { data: { name: `Alpha ${u}`, crm_key: `alpha-${u}` } })).json();
  await page.request.post("/api/projects", { data: { name: `Beta ${u}`, crm_key: `beta-${u}` } });
  await page.request.post("/api/modules/publications", { data: { enabled: true } });
  const day = new Date().toISOString().slice(0, 10);
  await page.request.post("/api/publications", { data: { day, title: `Post Alpha ${u}`, project: `alpha-${u}`, network: "x" } });
  await page.request.post("/api/publications", { data: { day, title: `Post Beta ${u}`, project: `beta-${u}`, network: "x" } });
  await page.request.post("/api/pub-accounts", { data: { project: a.id, network: "x", label: `Compte Alpha ${u}` } });
  await page.request.post("/api/pub-accounts", { data: { project: `beta-${u}`, network: "x", label: `Compte Beta ${u}` } });

  // Onglet Publications du projet Alpha : ses publications et ses comptes seulement.
  await page.goto(`/?view=project&id=${a.id}&tab=publications`);
  await expect(page.getByText(`Post Alpha ${u}`).first()).toBeVisible();
  await expect(page.getByText(`Post Beta ${u}`)).toHaveCount(0);
  await expect(page.getByRole("cell", { name: `Compte Alpha ${u}` }).first()).toBeVisible();
  await expect(page.getByRole("cell", { name: `Compte Beta ${u}` })).toHaveCount(0);

  // Nouvelle publication depuis le projet : projet prérempli, seuls ses comptes proposés.
  await page.getByRole("button", { name: "Nouvelle publication" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Projet", { exact: true })).toHaveValue(`alpha-${u}`);
  const options = await dialog.getByLabel("Compte de publication").locator("option").allTextContents();
  expect(options.some((o) => o.includes(`Compte Alpha ${u}`))).toBe(true);
  expect(options.some((o) => o.includes(`Compte Beta ${u}`))).toBe(false);
  await dialog.getByRole("button", { name: "Fermer" }).click();

  // Page Publications : le sélecteur filtre sur un projet.
  await page.goto("/?view=pubs");
  await expect(page.getByText(`Post Beta ${u}`).first()).toBeVisible();
  await page.getByRole("group", { name: "Projet affiché" }).getByRole("button", { name: `Alpha ${u}` }).click();
  await expect(page.getByText(`Post Beta ${u}`)).toHaveCount(0);
  await expect(page.getByText(`Post Alpha ${u}`).first()).toBeVisible();
});
