// C3/C4 : un projet se désigne par son identifiant ; la navigation mène au bon endroit.
import { test, expect, type Page } from "@playwright/test";

async function login(page: Page) {
  await page.goto("/");
  await page.locator('input[name="password"]').fill("e2e-mot-de-passe");
  await page.keyboard.press("Enter");
  await page.waitForLoadState("networkidle");
}

test("un contact créé avec le projet apparaît dans Projet → Contacts", async ({ page }) => {
  await login(page);
  const u = Date.now().toString(36);
  const p = await (await page.request.post("/api/projects", { data: { name: `Projet contacts ${u}` } })).json();
  await page.request.put(`/api/projects/${p.id}/modules/crm`, { data: { enabled: true } });
  const c = await (await page.request.post("/api/contacts", { data: { name: `Contact ${u}`, project: p.id } })).json();
  await page.goto(`/?view=project&id=${p.id}&tab=contacts`);
  await expect(page.getByText(`Contact ${u}`).first()).toBeVisible({ timeout: 10_000 });
  await page.request.delete(`/api/contacts/${c.id}`);
  await page.request.delete(`/api/projects/${p.id}`);
  await page.request.post("/api/modules/crm", { data: { enabled: false } });
});

test("SEO en sous-onglets, anciennes adresses de site et espace Rapports", async ({ page }) => {
  await login(page);
  const u = Date.now().toString(36);
  const domain = `nav-${u}.test`;
  const p = await (await page.request.post("/api/projects", { data: { name: `Projet nav ${u}` } })).json();
  const site = await (await page.request.post("/api/sites", { data: { domain } })).json();
  await page.request.patch(`/api/projects/${p.id}`, { data: { sites: [domain] } });

  // SEO : quatre sous-onglets dans le projet
  await page.goto(`/?view=project&id=${p.id}&tab=seo`);
  const seo = page.getByRole("group", { name: "Sections SEO" });
  await expect(seo.getByRole("button")).toHaveText(["Google", "Audit", "Contenus", "Visibilité IA"]);
  await seo.getByRole("button", { name: "Contenus" }).click();
  await expect(page).toHaveURL(/tab=seo&sub=contenus/);

  // Une ancienne adresse de site appartenant à un projet ouvre le projet, onglet SEO
  await page.goto(`/?site=${domain}&tab=search`);
  await expect.poll(() => page.evaluate(() => ({
    view: new URLSearchParams(location.search).get("view"),
    id: new URLSearchParams(location.search).get("id"),
    tab: new URLSearchParams(location.search).get("tab"),
    sub: new URLSearchParams(location.search).get("sub"),
  }))).toEqual({ view: "project", id: p.id, tab: "seo", sub: "google" });

  // Les anciens espaces Projets et Rapport de la semaine vivent dans Rapports
  await page.goto("/?view=projects");
  await expect(page.getByRole("heading", { name: "Rapports", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Portefeuille", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.goto("/?view=report");
  await expect(page.getByRole("button", { name: "Rapport de la semaine", exact: true })).toHaveAttribute("aria-pressed", "true");

  // Accueil : le mur et les pages sont des onglets
  await page.goto("/");
  await expect(page.getByRole("group", { name: "Pages de l'accueil" }).getByRole("button", { name: "Mur", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Sites sans projet")).toBeVisible();
  await page.request.delete(`/api/sites/${site.id}`);
  await page.request.delete(`/api/projects/${p.id}`);
});
