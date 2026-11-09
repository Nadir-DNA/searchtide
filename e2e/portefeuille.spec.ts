// T35, CA22 : vue Portefeuille par l'interface — le choix de colonnes survit à un rechargement,
// et un total mêlant deux devises affiche « Devises mélangées » au lieu d'une somme.
// Vrai serveur, vraie base ; Stripe est simulé côté serveur (e2e/fake-providers.ts), aucune requête réelle.
import { test, expect, type Page } from "@playwright/test";

const tag = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

async function login(page: Page) {
  await page.goto("/");
  await page.locator('input[name="password"]').fill("e2e-mot-de-passe");
  await page.keyboard.press("Enter");
  await page.waitForLoadState("networkidle");
}

/** Crée une connexion Stripe dont la devise simulée dépend de la clé (« USD » → dollars). */
async function stripe(page: Page, currency: "EUR" | "USD", name: string) {
  const values = { key: `rk_test_${currency}${tag()}abcdefgh` };
  const r = await page.request.post("/api/connections", { data: { kind: "stripe", label: name, values } });
  expect(r.status(), await r.text()).toBe(201);
  return (await r.json()).connection.id as string;
}

async function projectWithRevenue(page: Page, name: string, connectionId: string) {
  const project = await (await page.request.post("/api/projects", { data: { name } })).json();
  const r = await page.request.post(`/api/projects/${project.id}/sources`, {
    data: { connection_id: connectionId, items: [{ kpi: "revenue" }, { kpi: "mrr" }, { kpi: "active_subscriptions" }] },
  });
  expect(r.status(), await r.text()).toBe(201);
  return project.id as string;
}

test("CA22 : colonnes du Portefeuille conservées après rechargement, devises mélangées non additionnées", async ({ page }) => {
  await login(page);
  const id = tag();
  const eur = await stripe(page, "EUR", `Compte euros ${id}`);
  const usd = await stripe(page, "USD", `Compte dollars ${id}`);
  const a = await projectWithRevenue(page, `Portefeuille euros ${id}`, eur);
  const b = await projectWithRevenue(page, `Portefeuille dollars ${id}`, usd);

  // Côté serveur : les deux projets portent bien une mesure « CA net » dans deux devises différentes.
  const data = await (await page.request.get("/api/portfolio?days=7")).json();
  const pa = data.projects.find((p: any) => p.id === a), pb = data.projects.find((p: any) => p.id === b);
  expect(pa.measures.revenue.unit).toBe("€");
  expect(pb.measures.revenue.unit).toBe("$");

  // État de départ connu, même si la base e2e garde un réglage d'une répétition précédente.
  await page.request.put("/api/portfolio/columns", { data: { columns: [] } });
  await page.goto("/?view=portfolio");
  const table = page.getByRole("table");
  await expect(table.getByRole("columnheader", { name: "Projet" })).toBeVisible();

  // Choix de colonnes par l'interface : deux mesures, dont celle qui porte des devises.
  await page.getByRole("button", { name: /Colonnes/ }).click();
  const panel = page.getByRole("group", { name: "Colonnes affichées" });
  for (const label of ["CA net", "Abonnements actifs"]) {
    const box = panel.getByRole("checkbox", { name: label });
    await expect(box).not.toBeChecked();
    await box.click();                       // case contrôlée : le clic déclenche un PUT, l'état suit la réponse
    await expect(box).toBeChecked();
  }
  await expect(table.getByRole("columnheader", { name: /CA net/ })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: /Abonnements actifs/ })).toBeVisible();
  // Le réglage est enregistré côté serveur (ordre compris), pas seulement dans l'état du composant.
  await expect.poll(async () => (await (await page.request.get("/api/portfolio/columns")).json()).columns).toEqual(["revenue", "active_subscriptions"]);

  const saved = (await (await page.request.get("/api/portfolio/columns")).json()).columns as string[];

  // Rechargement complet : les mêmes colonnes reviennent dans le même ordre.
  await page.reload();
  await expect(table.getByRole("columnheader", { name: /Abonnements actifs/ })).toBeVisible();
  const heads = await table.getByRole("columnheader").allInnerTexts();
  const positions = saved.map((k) => heads.findIndex((h) => h.includes({ revenue: "CA net", mrr: "MRR", active_subscriptions: "Abonnements actifs" }[k] ?? k)));
  expect(positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1])), `ordre ${heads.join(" | ")}`).toBe(true);

  // Ligne Total : deux devises → « Devises mélangées » ; jamais une somme.
  const total = table.getByRole("row").last();
  await expect(total).toContainText("Devises mélangées");
  const totalText = await total.innerText();
  expect(totalText).not.toMatch(/(^|\s)18\s*[€$]/);   // 9 + 9 ne doit jamais être additionné
});
