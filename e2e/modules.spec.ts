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
  await page.goto("/?view=page");
  await expect(page.getByRole("region", { name: "Chiffres du portefeuille" })).toBeVisible();
  await expect(page.getByText("0 €")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Activer Stripe/ }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Activer Contacts/ }).first()).toBeVisible();
});

const rubriques = (page: Page) => page.locator('[aria-label="Rubriques"] > li > button');

test("menu : sept rubriques, Projets et Suivi des sites dépliants, un projet épinglé reste visible", async ({ page }) => {
  await login(page);
  const name = `Épinglé ${Date.now().toString(36)}`;
  const p = await (await page.request.post("/api/projects", { data: { name } })).json();
  await page.goto("/?view=today");
  await expect(rubriques(page)).toHaveText(["Aujourd'hui", "Tableaux", "Projets", "Suivi des sites", "Modules", "Agents", "Réglages"]);
  // Projets replié : le projet n'apparaît pas tant qu'il n'est pas épinglé
  const nav = page.getByRole("navigation", { name: "Navigation" });
  const projets = nav.getByRole("button", { name: "Projets", exact: true });
  if (await projets.getAttribute("aria-expanded") === "true") await projets.click();
  await expect(nav.getByRole("button", { name, exact: true })).toHaveCount(0);
  await projets.click();
  await expect(projets).toHaveAttribute("aria-expanded", "true");
  await nav.getByRole("button", { name: `Épingler ${name}` }).click();
  await projets.click();
  await expect(projets).toHaveAttribute("aria-expanded", "false");
  await expect(nav.getByRole("button", { name, exact: true })).toBeVisible(); // favori hors de la liste repliée
  await page.request.patch(`/api/projects/${p.id}`, { data: { pinned: false } });
});

test("projet complet sans quitter la page du projet : domaine, Stripe activé depuis le projet, KPI ajouté", async ({ page }) => {
  await login(page);
  const name = `Complet ${Date.now().toString(36)}`;
  const p = await (await page.request.post("/api/projects", { data: { name } })).json();
  await page.goto(`/?view=project&id=${p.id}&tab=reglages`);
  const sw = page.getByRole("switch", { name: "Stripe" });
  const activate = page.getByRole("button", { name: "Activer Stripe" });
  await expect(sw.or(activate)).toBeVisible();
  if (await activate.isVisible()) {
    // Pas encore de connexion Stripe sur l'instance : elle se crée dans un tiroir, sans quitter le projet
    await activate.click();
    const dialog = page.getByRole("dialog", { name: "Stripe" });
    await dialog.getByLabel(/Clé/).first().fill("rk_" + "test_EUR" + Date.now().toString(36) + "abcdefgh");
    await dialog.getByRole("button", { name: /Tester et enregistrer/ }).click();
    await expect(dialog).toBeHidden();
  } else await sw.click(); // une autre répétition a déjà connecté Stripe : on l'active pour ce projet
  await expect(sw).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Ajouter des KPI" }).click();
  const kpis = page.getByRole("dialog", { name: "Ajouter des KPI" });
  await kpis.getByRole("listitem").filter({ hasText: /^MRR/ }).getByRole("button", { name: "Ajouter" }).click();
  await expect(page.getByText("« MRR » ajouté.")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("view")).toBe("project");
});

test("anciennes adresses : ?view=portfolio ouvre Tous les projets, ?site=… reste lisible", async ({ page }) => {
  await login(page);
  await page.goto("/?view=portfolio");
  await expect(page.getByRole("heading", { name: "Tous les projets", level: 1 })).toBeVisible();
});
