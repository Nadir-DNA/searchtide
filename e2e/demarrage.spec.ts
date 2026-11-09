// T16, CA4 et CA23 (onboarding) : parcours de premier lancement sur le VRAI serveur, base neuve, fournisseurs simulés côté serveur
// (e2e/fake-providers.ts). Ce fichier doit passer avant les autres qui créent des sites et des projets (ordre alphabétique).
import { test, expect, type Page } from "@playwright/test";

const noHScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth);
const step = (page: Page, title: RegExp) => page.getByRole("heading", { name: title });

test.use({ viewport: { width: 375, height: 812 } });

test("CA4 + CA23 : onboarding en 4 étapes, étape 2 cochée après une vraie connexion, 375 px sans défilement horizontal, clavier", async ({ page }) => {
  await page.goto("/");
  await page.locator('input[name="password"]').fill("e2e-mot-de-passe");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Bienvenue", level: 1 })).toBeVisible();
  const titles = [/Ajouter votre site et coller le script/, /Connecter vos services/, /Créer un projet et lui rattacher vos sources/, /Donner accès à un agent IA/];
  for (const t of titles) { await expect(step(page, t)).toBeVisible(); await expect(step(page, t)).toContainText("(à faire)"); }
  await expect(page.getByRole("heading", { level: 3 })).toHaveCount(4);
  expect(await noHScroll(page)).toBe(true);

  // Étape 1 : un site, le script apparaît avec son domaine
  await page.getByLabel("Domaine").fill("exemple.com");
  await page.getByRole("button", { name: "Ajouter le site" }).click();
  await expect(step(page, titles[0])).toContainText("(terminée)");
  await expect(page.getByText('data-site="exemple.com"')).toBeVisible();

  // Étape 2 : Stripe, clavier seul pour ouvrir (Entrée), saisie, test et enregistrement par le vrai serveur
  await expect(step(page, titles[1])).toContainText("(à faire)");
  const stripe = page.getByRole("button", { name: /^Stripe : non connecté/ });
  await stripe.focus(); await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Stripe" });
  await expect(dialog).toBeVisible();
  expect(await noHScroll(page)).toBe(true);
  await dialog.getByLabel(/Clé limitée/).fill("rk_" + "test_E2Eonboarding0123456789");
  await dialog.getByRole("button", { name: "Tester et enregistrer" }).click();
  await expect(dialog.getByRole("status")).toContainText("Connecté : Boutique démo");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(step(page, titles[1])).toContainText("(terminée)");              // CA4
  await expect(page.getByRole("button", { name: /^Stripe : connecté/ })).toBeFocused();   // le focus revient à la carte
  expect(await noHScroll(page)).toBe(true);

  // Étape 4 : une clé d'agent générée dans l'interface (plus de « dans .env »)
  await page.getByLabel("Nom de l'agent").fill("Mon agent");
  await page.getByRole("button", { name: "Créer une clé pour cet agent" }).click();
  await expect(page.getByText(/Authorization: Bearer ck_/)).toBeVisible();
  await expect(step(page, titles[3])).toContainText("(terminée)");
  await expect(page.getByText(".env")).toHaveCount(0);
  await expect(page.getByText("3 étapes sur 4 terminées.")).toBeVisible();

  // Étape 3 : ouvre la création d'un projet
  await page.getByRole("button", { name: "Créer mon premier projet" }).click();
  await expect(page.getByRole("heading", { name: /Nouveau projet|Créer/ }).first()).toBeVisible();
  expect(await noHScroll(page)).toBe(true);
});

test("« Démarrage » reste dans le menu ; « Passer pour l'instant » est toujours possible", async ({ page }) => {
  await page.goto("/");
  await page.locator('input[name="password"]').fill("e2e-mot-de-passe");
  await page.keyboard.press("Enter");
  await page.waitForLoadState("networkidle");
  await page.goto("/?view=start");
  await expect(page.getByRole("heading", { name: "Bienvenue", level: 1 })).toBeVisible();
  await expect(step(page, /Connecter vos services/)).toContainText("(terminée)");   // état conservé d'une visite à l'autre
  await expect(page.getByText("Connecté", { exact: false }).first()).toBeVisible();
  await page.getByRole("button", { name: "Passer pour l'instant" }).click();
  await expect(page.getByRole("heading", { name: "Bienvenue", level: 1 })).toHaveCount(0);
});
