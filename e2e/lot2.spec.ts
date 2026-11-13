// Lot 2 : script vérifiable (1.1), période retenue (B3), thème Auto (B4), onglets d'installation (A2).
import { test, expect, type Page } from "@playwright/test";

async function login(page: Page) {
  await page.goto("/");
  await page.locator('input[name="password"]').fill("e2e-mot-de-passe");
  await page.keyboard.press("Enter");
  await page.waitForLoadState("networkidle");
}

test("CA 1.1 : une visite acceptée fait apparaître « dernière visite » dans Installation sans recharger", async ({ page }) => {
  await login(page);
  const domain = `suivi-${Date.now().toString(36)}.test`;
  await page.request.post("/api/sites", { data: { domain } });
  await page.goto(`/?site=${domain}&tab=setup`);
  await expect(page.getByText("Aucune visite reçue pour l'instant.")).toBeVisible();
  const r = await page.request.post("/api/collect", {
    data: { site: domain, url: `https://${domain}/` },
    headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0 Safari/537.36" },
  });
  expect(r.status()).toBe(202);
  await expect(page.getByText(/Dernière visite reçue il y a/)).toBeVisible({ timeout: 12_000 });
});

test("CA B3 : la période choisie est retenue d'une visite à l'autre", async ({ page }) => {
  await login(page);
  await page.evaluate(() => localStorage.removeItem("st-days"));
  await page.goto("/?view=today&days=90");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("st-days"))).toBe("90");
  await page.goto("/?view=today");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("st-days"))).toBe("90");
});

test("CA B4 : Auto suit le système, Sombre reste le défaut", async ({ page }) => {
  await login(page);
  const more = () => page.getByRole("button", { name: "Plus", exact: true }).click();
  await more();
  await page.getByRole("group", { name: "Thème" }).getByRole("button", { name: "Auto" }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("light");
  await page.reload();
  await page.waitForLoadState("networkidle");
  await more();
  await expect(page.getByRole("group", { name: "Thème" }).getByRole("button", { name: "Auto" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("group", { name: "Thème" }).getByRole("button", { name: "Sombre" }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
});

test("CA A2 : cinq onglets d'installation, sans Astro ni PHP", async ({ page }) => {
  await login(page);
  const domain = `onglets-${Date.now().toString(36)}.test`;
  await page.request.post("/api/sites", { data: { domain } });
  await page.goto(`/?site=${domain}&tab=setup`);
  const tools = page.getByRole("group", { name: "Outil" });
  await expect(tools.getByRole("button")).toHaveText(["HTML", "Next.js", "WordPress", "Shopify", "GTM"]);
  await expect(page.getByText(`data-site="${domain}"`)).toBeVisible();
  await expect(tools.getByRole("button", { name: "Astro" })).toHaveCount(0);
  await expect(tools.getByRole("button", { name: "PHP" })).toHaveCount(0);
});
