// T18, CA17 et CA18 par l'interface : retirer une connexion utilisée (confirmation nominative, indicateurs et historique conservés),
// remplacer une clé sous le même id. Vrai serveur ; Stripe simulé côté serveur (e2e/fake-providers.ts).
import { test, expect, type Page } from "@playwright/test";

async function login(page: Page) {
  await page.goto("/");
  await page.locator('input[name="password"]').fill("e2e-mot-de-passe");
  await page.keyboard.press("Enter");
  await page.waitForLoadState("networkidle");
}
const stripeConnections = async (page: Page) => (await (await page.request.get("/api/connectors")).json()).connectors.find((c: any) => c.id === "stripe").connections as any[];

test("CA17 : « Retirer » cite les 2 indicateurs ; après confirmation ils existent toujours, historique intact, statut « Source retirée »", async ({ page }) => {
  await login(page);
  const created = await (await page.request.post("/api/connections", { data: { kind: "stripe", label: "Compte à retirer", values: { key: "rk_" + "test_E2Eretrait0123456789" } } })).json();
  const conn = created.connection.id as string;
  const project = await (await page.request.post("/api/projects", { data: { name: "Projet retrait" } })).json();
  const att = await page.request.post(`/api/projects/${project.id}/sources`, { data: { connection_id: conn, items: [{ kpi: "revenue" }, { kpi: "mrr" }] } });
  expect(att.status()).toBe(201);
  const before = await (await page.request.get(`/api/projects/${project.id}`)).json();
  expect(before.indicators.map((i: any) => i.value).filter((v: any) => v != null).length).toBeGreaterThan(0);

  await page.goto("/?view=connections");
  await page.getByRole("button", { name: /^Stripe :/ }).click();
  const dialog = page.getByRole("dialog", { name: "Stripe" });
  await dialog.locator("li", { hasText: "Compte à retirer" }).getByRole("button", { name: "Retirer" }).click();
  const confirm = dialog.getByRole("alertdialog");
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("2 indicateurs l'utilisent");
  await expect(confirm).toContainText("CA net (Projet retrait)");
  await expect(confirm).toContainText("MRR (Projet retrait)");
  await expect(confirm).toContainText("Leur historique est conservé");
  await expect(confirm.getByRole("link", { name: /ouvrir/ })).toHaveAttribute("href", "https://dashboard.stripe.com/apikeys");
  await expect(confirm.getByRole("button", { name: "Annuler" })).toBeFocused();
  // Annuler ne retire rien
  await confirm.getByRole("button", { name: "Annuler" }).click();
  expect((await stripeConnections(page)).some((c) => c.id === conn)).toBe(true);
  await dialog.locator("li", { hasText: "Compte à retirer" }).getByRole("button", { name: "Retirer" }).click();
  await confirm.getByRole("button", { name: "Retirer définitivement" }).click();
  await expect(dialog.getByRole("status")).toContainText("« Compte à retirer » est retiré.", { timeout: 10_000 });
  await expect(dialog.getByRole("status")).toContainText("2 indicateurs passent en « Source retirée »");

  expect((await stripeConnections(page)).some((c) => c.id === conn)).toBe(false);
  const after = await (await page.request.get(`/api/projects/${project.id}`)).json();
  expect(after.indicators).toHaveLength(2);                                               // ils existent toujours
  for (const i of after.indicators) expect(i.last_error).toBe("Source retirée");           // statut « Source retirée »
  expect(after.indicators.map((i: any) => i.value)).toEqual(before.indicators.map((i: any) => i.value));   // historique intact
  await page.keyboard.press("Escape");
  await page.goto(`/?view=project&id=${project.id}`);
  await expect(page.getByText("● Source retirée")).toBeVisible();
  await expect(page.getByText("Erreur : Source retirée").first()).toBeVisible();
});

test("CA18 : « Remplacer la clé » garde l'id de la connexion ; les indicateurs liés continuent d'être relevés", async ({ page }) => {
  await login(page);
  const created = await (await page.request.post("/api/connections", { data: { kind: "stripe", label: "Compte rotation", values: { key: "rk_" + "test_E2Erotation0123456789" } } })).json();
  const conn = created.connection.id as string;
  const project = await (await page.request.post("/api/projects", { data: { name: "Projet rotation" } })).json();
  await page.request.post(`/api/projects/${project.id}/sources`, { data: { connection_id: conn, items: [{ kpi: "mrr" }] } });

  await page.goto("/?view=connections");
  await page.getByRole("button", { name: /^Stripe :/ }).click();
  const dialog = page.getByRole("dialog", { name: "Stripe" });
  await dialog.locator("li", { hasText: "Compte rotation" }).getByRole("button", { name: "Remplacer la clé" }).click();
  await expect(dialog.getByText("Laisser vide pour garder la clé actuelle.")).toBeVisible();
  await dialog.getByLabel(/Clé limitée/).fill("rk_" + "test_E2ENouvelleCle0123456789");
  await dialog.getByRole("button", { name: "Tester et enregistrer" }).click();
  await expect(dialog.getByRole("status")).toContainText("Connecté");
  const list = await stripeConnections(page);
  const mine = list.filter((c) => c.label === "Compte rotation" || c.id === conn);
  expect(mine).toHaveLength(1); expect(mine[0].id).toBe(conn);                              // même id, pas de doublon
  expect(mine[0].hint).toContain("…" + ("rk_" + "test_E2ENouvelleCle0123456789").slice(-4));  // le nouvel indice
  const p = await (await page.request.get(`/api/projects/${project.id}`)).json();
  expect(p.indicators[0].config.connection_id).toBe(conn); expect(p.indicators[0].last_error).toBeNull();
  const res = await page.request.post("/api/indicators/test", { data: { label: "MRR", mode: "total", source: "stripe", config: { metric: "mrr", connection_id: conn } } });
  expect((await res.json()).value).toBe(29);
});
