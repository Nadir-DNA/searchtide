// B3/L2 : publication par le navigateur sur une page de test locale, depuis le compositeur.
import { test, expect, type Page } from "@playwright/test";
import { startFixtures } from "../server/browser/fixtures.ts";

async function login(page: Page) {
  await page.goto("/");
  await page.locator('input[name="password"]').fill("e2e-mot-de-passe");
  await page.keyboard.press("Enter");
  await page.waitForLoadState("networkidle");
}

test("B3 : compte navigateur, publication immédiate, preuve lue sur la page de test", async ({ page }) => {
  await login(page);
  const fixtures = await startFixtures();
  try {
    const key = `web-${Date.now().toString(36)}`;
    const project = await (await page.request.post("/api/projects", { data: { name: "Projet navigateur", crm_key: key } })).json();
    const account = await (await page.request.post("/api/pub-accounts", { data: { project: key, network: "x", label: "Compte navigateur", mode: "web", web_url: `${fixtures.url}/composer` } })).json();
    expect(account.mode).toBe("web");

    await page.goto("/?view=pubs");
    await page.getByRole("button", { name: "Nouvelle publication" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Titre (pour vous) *").fill("Publication navigateur");
    await dialog.getByRole("combobox", { name: "Projet", exact: true }).selectOption(key);
    await dialog.getByRole("checkbox", { name: /Compte navigateur/ }).check();
    await dialog.getByLabel(/^Texte pour Compte navigateur/).fill("Bonjour depuis le navigateur");
    await dialog.getByRole("button", { name: "Maintenant", exact: true }).click();
    await dialog.getByRole("button", { name: "Publier maintenant" }).click();
    await expect(dialog).toBeHidden({ timeout: 20_000 });
    await page.getByRole("button", { name: /Publication navigateur/ }).first().click();
    const suivi = page.getByRole("dialog");
    await suivi.getByText("Suivi", { exact: true }).click();
    await expect(suivi.getByText("● Publiée")).toBeVisible({ timeout: 20_000 });
    await expect(suivi.getByRole("link", { name: "Voir la preuve" })).toHaveAttribute("href", "https://exemple.test/posts/1");

    // Le projet témoin et le compte restent cohérents.
    expect((await (await page.request.get(`/api/projects/${project.id}`)).json()).id).toBe(project.id);
  } finally { await fixtures.close(); }
});
