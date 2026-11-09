// T20 : réglage des poids du score de santé (Réglages). Vrai serveur, vraie base.
import { test, expect, type Page } from "@playwright/test";

async function login(page: Page) {
  await page.goto("/");
  await page.locator('input[name="password"]').fill("e2e-mot-de-passe");
  await page.keyboard.press("Enter");
  await page.waitForLoadState("networkidle");
}
const noHScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth);

test("poids du score : valeurs par défaut, aperçu recalculé en direct, enregistrement conservé après rechargement, rétablissement, refus des valeurs hors de 0 à 100", async ({ page }) => {
  await login(page);
  await page.request.post("/api/projects", { data: { name: "Projet pour le score" } });
  await page.goto("/?view=settings");
  const card = page.locator("section", { has: page.getByRole("heading", { name: "Score de santé des projets" }) });
  await expect(card).toBeVisible();
  const field = (name: string) => card.getByLabel(name, { exact: true });
  for (const [n, v] of [["Tendance", "30"], ["Objectifs", "25"], ["Fiabilité des données", "20"], ["Conversion", "15"], ["Action", "10"]]) await expect(field(n)).toHaveValue(v);
  await expect(card.getByText("Projet pour le score")).toBeVisible();                                   // aperçu pour chaque projet

  // L'aperçu est recalculé avec les poids saisis (sans enregistrer)
  const sent = page.waitForRequest((r) => r.url().includes("/api/health/preview") && r.postData()?.includes('"trend":"10"') === true);
  await field("Tendance").fill("10");
  const req = await sent;
  expect(JSON.parse(req.postData()!).weights).toMatchObject({ trend: "10", goals: "25", reliability: "20" });
  expect((await (await page.request.get("/api/health/weights")).json()).weights.trend).toBe(30);       // rien d'enregistré

  // Enregistrer, recharger : le choix est conservé
  await field("Fiabilité des données").fill("40");
  await card.getByRole("button", { name: "Enregistrer les poids" }).click();
  await expect(card.getByRole("status")).toContainText("Poids enregistrés.");
  await page.reload();
  await expect(field("Tendance")).toHaveValue("10"); await expect(field("Fiabilité des données")).toHaveValue("40");

  // Valeur hors de 0 à 100 : refus avec le message du serveur, rien n'est enregistré
  await field("Objectifs").fill("150");
  await card.getByRole("button", { name: "Enregistrer les poids" }).click();
  await expect(card.getByRole("status")).toContainText("Objectifs : un nombre de 0 à 100 est attendu.");
  expect((await (await page.request.get("/api/health/weights")).json()).weights.goals).toBe(25);

  // Rétablir les valeurs par défaut
  await card.getByRole("button", { name: "Rétablir les valeurs par défaut" }).click();
  for (const [n, v] of [["Tendance", "30"], ["Objectifs", "25"], ["Fiabilité des données", "20"], ["Conversion", "15"], ["Action", "10"]]) await expect(field(n)).toHaveValue(v);
  await card.getByRole("button", { name: "Enregistrer les poids" }).click();
  await expect.poll(async () => (await (await page.request.get("/api/health/weights")).json()).weights).toEqual({ trend: 30, goals: 25, reliability: 20, conversion: 15, action: 10 });
});

test.describe("375 px", () => {
  test.use({ viewport: { width: 375, height: 812 } });
  test("CA23 : les réglages du score tiennent sans défilement horizontal", async ({ page }) => {
    await login(page);
    await page.goto("/?view=settings");
    await expect(page.getByRole("heading", { name: "Score de santé des projets" })).toBeVisible();
    expect(await noHScroll(page)).toBe(true);
  });
});
