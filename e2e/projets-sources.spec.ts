// T17, CA19 et E3 : section « Sources » d'un projet, rattachement d'une connexion, éditeur d'indicateurs avec « Connexion ».
// Vrai serveur, vraie base, vrai chiffrement ; seuls les fournisseurs (Stripe, Google) sont simulés côté serveur (e2e/fake-providers.ts).
import { test, expect, type Page } from "@playwright/test";
import { GOOGLE_JSON } from "../server/connectors/fixtures.ts";

const noHScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth);
async function login(page: Page) {
  await page.goto("/");
  await page.locator('input[name="password"]').fill("e2e-mot-de-passe");
  await page.keyboard.press("Enter");
  await page.waitForLoadState("networkidle");
}
/** Crée (ou retrouve) une connexion portant ce libellé : d'autres fichiers e2e en ont créé avant, sur la même base. */
async function connection(page: Page, kind: string, values: Record<string, string>, label: string) {
  await page.request.post("/api/connections", { data: { kind, label, values } }); // 409 si déjà présente : sans importance
  const cat = await (await page.request.get("/api/connectors")).json();
  const mine = cat.connectors.find((c: any) => c.id === kind).connections;
  return (mine.find((c: any) => c.label === label) ?? mine[0]).id as string;
}

test("CA19 : « Rattacher » crée les indicateurs cochés avec config.connection_id ; « Tester » d'un indicateur affiche une valeur ; aucune variable .env préremplie (E3)", async ({ page }) => {
  await login(page);
  const stripe = await connection(page, "stripe", { key: "rk_" + "test_E2Esources0123456789" }, "Compte sources");
  const project = await (await page.request.post("/api/projects", { data: { name: "Projet sources" } })).json();
  await page.goto(`/?view=project&id=${project.id}`);

  // Section Sources vide, puis rattachement
  const card = page.getByRole("region", { name: "Sources" }).or(page.locator("section", { has: page.getByRole("heading", { name: "Sources" }) }));
  await expect(card.getByText("Aucune source rattachée")).toBeVisible();
  await card.getByRole("button", { name: "Rattacher" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Rattacher une source" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("radio", { name: /Compte sources/ }).check();
  for (const l of ["CA net", "MRR", "Abonnements actifs", "Nouveaux clients"]) await expect(dialog.getByRole("checkbox", { name: new RegExp(l) })).toBeChecked();
  await dialog.getByRole("checkbox", { name: /Nouveaux clients/ }).uncheck();
  await dialog.getByRole("button", { name: "Ajouter les indicateurs" }).click();
  await expect(dialog).toBeHidden();
  await expect(card.getByRole("status")).toContainText("3 indicateurs ajoutés");

  // Côté serveur : 3 indicateurs, chacun relié à la connexion, aucune variable d'environnement
  const p = await (await page.request.get(`/api/projects/${project.id}`)).json();
  expect(p.indicators.map((i: any) => i.label).sort()).toEqual(["Abonnements actifs", "CA net", "MRR"]);
  for (const i of p.indicators) { expect(i.config.connection_id).toBe(stripe); expect(i.config.env).toBeUndefined(); }
  // La section Sources les regroupe sous la connexion, avec son statut en texte
  await expect(card.getByText("Stripe · Compte sources")).toBeVisible();
  await expect(card.getByText(/^3 indicateurs · /)).toBeVisible();
  await expect(card.getByText("● Connecté")).toBeVisible();
  // Le MRR (29 €) a été relevé au rattachement
  await expect(page.getByText("29 €").first()).toBeVisible();

  // Éditeur : « Connexion » remplace « Variable .env », « Tester » affiche une valeur
  await page.getByRole("button", { name: "Gérer le projet" }).click();
  await page.locator("li", { hasText: "MRR" }).getByRole("button", { name: "Modifier" }).click();
  const connexion = page.getByLabel(/^Connexion/);
  await expect(connexion).toBeVisible();
  await expect(connexion.locator("option:checked")).toContainText("Compte sources");
  await expect(page.locator('input[name="env"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Tester", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Valeur aujourd'hui" })).toContainText("29");
  // Changer de source ne préremplit aucune variable (E3) ; sans connexion PageSpeed, l'éditeur le dit
  await page.locator("select", { has: page.locator('option[value="pagespeed"]') }).selectOption("pagespeed");
  await expect(page.locator('input[name="env"]')).toHaveCount(0);
  await expect(page.getByText(/Aucune connexion PageSpeed/)).toBeVisible();
  await expect(page.getByText("PAGESPEED_KEY")).toHaveCount(0);
  await page.locator("select", { has: page.locator('option[value="pagespeed"]') }).selectOption("play");
  await expect(page.getByText("PLAY_BUCKET")).toHaveCount(0);
  // L'option avancée n'envoie une variable que si elle est saisie
  await page.getByLabel(/^Connexion/).selectOption("__env");
  await expect(page.locator('input[name="env"]')).toHaveValue("");
});

test("Search Console rattachée au site (sites.gsc_property), sans créer d'indicateur ; ligne « Non rattaché » puis propriété choisie", async ({ page }) => {
  await login(page);
  await connection(page, "google", { json: GOOGLE_JSON }, "Compte Google sources");
  const site = await (await page.request.post("/api/sites", { data: { domain: "sources-gsc.test" } })).json();
  const project = await (await page.request.post("/api/projects", { data: { name: "Projet SC", sites: ["sources-gsc.test"] } })).json();
  await page.goto(`/?view=project&id=${project.id}`);
  const line = page.getByText("Search Console · sources-gsc.test");
  await expect(line).toBeVisible();
  await expect(page.getByText("Non rattaché").first()).toBeVisible();
  await page.getByLabel("Propriété Search Console de sources-gsc.test").selectOption("sc-domain:exemple.com");
  await expect.poll(async () => (await (await page.request.get("/api/sites")).json()).find((s: any) => s.domain === "sources-gsc.test").gsc_property).toBe("sc-domain:exemple.com");
  const p = await (await page.request.get(`/api/projects/${project.id}`)).json();
  expect(p.indicators).toHaveLength(0);                                    // aucun indicateur créé
  expect(site.domain).toBe("sources-gsc.test");
  // projet sans site : le message demandé par la spec
  const vide = await (await page.request.post("/api/projects", { data: { name: "Projet sans site" } })).json();
  await page.goto(`/?view=project&id=${vide.id}`);
  await expect(page.getByText("Ajoutez d'abord un site au projet pour rattacher Search Console")).toBeVisible();
});

test.describe("375 px", () => {
  test.use({ viewport: { width: 375, height: 812 } });
  test("CA23 : la page projet avec ses Sources et le panneau de rattachement tiennent sans défilement horizontal, clavier et Échap", async ({ page }) => {
    await login(page);
    await connection(page, "stripe", { key: "rk_" + "test_E2Esources0123456789" }, "Compte sources");
    const project = await (await page.request.post("/api/projects", { data: { name: "Projet mobile" } })).json();
    await page.goto(`/?view=project&id=${project.id}`);
    const rattacher = page.getByRole("button", { name: "Rattacher" }).first();
    await rattacher.focus(); await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Rattacher une source" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("radio", { name: /Compte sources/ }).check();
    expect(await noHScroll(page)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(rattacher).toBeFocused();
    expect(await noHScroll(page)).toBe(true);
  });
});
