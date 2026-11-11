// J3 : écran « Connexions navigateur » — image SSE d'une page de test locale, fermeture, réservé à l'admin.
import { test, expect, type Page } from "@playwright/test";
import { startFixtures } from "../server/browser/fixtures.ts";

async function login(page: Page) {
  await page.goto("/");
  await page.locator('input[name="password"]').fill("e2e-mot-de-passe");
  await page.keyboard.press("Enter");
  await page.waitForLoadState("networkidle");
}

test("J3 : la vue navigateur affiche la page de test, puis se ferme", async ({ page }) => {
  await login(page);
  const fixtures = await startFixtures();
  try {
    const start = await page.request.post("/api/browser/live", { data: { url: `${fixtures.url}/composer`, fixture_port: fixtures.port } });
    expect(start.status()).toBe(201);
    const { ticket } = await start.json();

    await page.goto(`/?view=browser&ticket=${encodeURIComponent(ticket)}`);
    const img = page.getByAltText("Écran du navigateur distant");
    await expect(img).toBeVisible({ timeout: 15_000 });
    await expect(img).toHaveAttribute("src", /^data:image\/jpeg;base64,/);

    await page.getByRole("button", { name: "Fermer la vue" }).click();
    await expect.poll(async () => (await (await page.request.get("/api/browser/status")).json()).open).toBe(false);
  } finally { await fixtures.close(); }
});
