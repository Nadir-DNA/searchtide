// T10, CA23 : catalogue des connexions à 375 px. Serveur réel, mais /api/connectors et l'enregistrement sont SIMULÉS dans le navigateur.
import { test, expect, type Page } from "@playwright/test";

const manifest = (o: Record<string, unknown>) => ({
  provider: "Démo", category: "revenus", minutes: 3, unlocks: ["CA net", "MRR"], guide: [{ text: "Ouvrez la page des clés", url: "https://exemple.com/cles" }, { text: "Copiez la clé" }],
  fields: [{ key: "key", label: "Clé limitée", type: "text", secret: true, required: true, help: "Elle n'est montrée qu'une fois." }], connections: [], status: "none", ...o,
});
const catalog = (over: Record<string, unknown> = {}) => ({
  vault: { ok: true, message: null }, demo: false, admin: true, later: ["Cloudflare", "Gmail (lecture)", "Sauvegarde distante"],
  connectors: [
    manifest({ id: "stripe", name: "Stripe", monogram: "ST", description: "Lecture seule." }),
    manifest({ id: "google", name: "Google", monogram: "GO", category: "seo", minutes: 15, description: "Search Console." }),
    manifest({ id: "smtp", name: "E-mail (SMTP)", monogram: "@", category: "alertes", minutes: 5, status: "connected", singleton: true, description: "Rapport par e-mail.",
      connections: [{ id: "c1", kind: "smtp", label: "Mon e-mail", hint: "moi@exemple.com", settings: {}, status: "connected", status_detail: null, tested_at: Date.now() - 7200000, livemode: false, test_mode: false }] }),
    manifest({ id: "ntfy", name: "ntfy", monogram: "NT", category: "alertes", minutes: 1, status: "reconnect", description: "Alertes.",
      connections: [{ id: "c2", kind: "ntfy", label: "Mon téléphone", hint: "sujet masqué", settings: {}, status: "reconnect", status_detail: "À reconnecter : la clé de l'instance a changé", tested_at: null, livemode: false, test_mode: false }] }),
    manifest({ id: "analytics", name: "Searchtide analytics", monogram: "SA", builtin: true, category: "integre", status: "builtin", minutes: 0, fields: [], guide: [], description: "Intégré." }),
  ],
  ...over,
});

async function open(page: Page, cat = catalog()) {
  await page.route("**/api/connectors", (r) => r.fulfill({ json: cat }));
  await page.goto("/");
  await page.locator('input[name="password"]').fill("e2e-mot-de-passe");
  await page.keyboard.press("Enter");
  await page.waitForLoadState("networkidle");
  await page.goto("/?view=connections");
  await expect(page.getByRole("heading", { name: "Connexions", level: 1 })).toBeVisible();
}
const noHScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth);

test.use({ viewport: { width: 375, height: 812 } });

test("CA23 : catalogue lisible à 375 px, sans défilement horizontal, statuts avec texte", async ({ page }) => {
  await open(page);
  expect(await noHScroll(page)).toBe(true);
  for (const t of ["Non connecté", "Connecté · 1 compte", "À reconnecter", "Intégré"]) await expect(page.getByText(t, { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Plus tard")).toBeVisible();
  // une carte par connecteur, sur une colonne
  const boxes = await page.getByRole("button", { name: /Connecter|Gérer/ }).evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ x: Math.round(r.x), w: Math.round(r.width) })));
  expect(boxes.length).toBe(4);
  expect(new Set(boxes.map((b) => b.x)).size).toBe(1);
});

test("CA23 : filtres par catégorie en boutons à bascule (aria-pressed)", async ({ page }) => {
  await open(page);
  const seo = page.getByRole("button", { name: "SEO", exact: true });
  await expect(page.getByRole("button", { name: "Tous", exact: true })).toHaveAttribute("aria-pressed", "true");
  await seo.click();
  await expect(seo).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: /^Google/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Stripe/ })).toHaveCount(0);
  expect(await noHScroll(page)).toBe(true);
});

test("CA23 : clavier complet — Entrée ouvre le tiroir, le focus est piégé, Échap ferme et rend le focus à la carte", async ({ page }) => {
  await open(page);
  const card = page.getByRole("button", { name: /^Stripe/ });
  await card.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Stripe" });
  await expect(dialog).toBeVisible();
  expect(await noHScroll(page)).toBe(true);
  // le focus entre dans le tiroir et n'en sort pas, dans les deux sens
  const inside = () => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'));
  await expect.poll(inside, { timeout: 3000 }).toBe(true); // le focus se stabilise dans le tiroir juste après l'ouverture
  for (let i = 0; i < 9; i++) { await page.keyboard.press("Tab"); expect(await inside(), `Tab ${i}`).toBe(true); }
  for (let i = 0; i < 9; i++) { await page.keyboard.press("Shift+Tab"); expect(await inside(), `Maj+Tab ${i}`).toBe(true); }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(card).toBeFocused();
});

test("tiroir : guide, champ secret masqué avec Afficher, échec → rien d'enregistré, succès → connecté", async ({ page }) => {
  let created = false;
  await open(page);
  await page.route("**/api/connections", async (r) => {
    if (r.request().method() !== "POST") return r.fallback();
    const sent = r.request().postDataJSON();
    if (sent.values.key === "rk_" + "live_mauvaise") return r.fulfill({ status: 400, json: { error: "Démo refuse cette clé : vérifiez qu'elle est complète et active." } });
    created = true; return r.fulfill({ status: 201, json: { connection: { id: "n1" }, test: { label: "Compte démo", detail: "Compte démo, mode production", warnings: ["Aucune propriété visible : ajoutez le compte de service."] } } });
  });
  await page.getByRole("button", { name: /^Stripe/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("link", { name: /Ouvrir/ })).toHaveAttribute("href", "https://exemple.com/cles");
  const key = dialog.getByLabel(/Clé limitée/);
  await expect(key).toHaveAttribute("type", "password");
  await dialog.getByRole("button", { name: "Afficher" }).click();
  await expect(key).toHaveAttribute("type", "text");
  await key.fill("rk_" + "live_mauvaise");
  await dialog.getByRole("button", { name: "Tester et enregistrer" }).click();
  await expect(dialog.getByRole("alert").filter({ hasText: "refuse cette clé" })).toBeVisible();
  expect(created).toBe(false);
  await key.fill("rk_live_valide");
  await dialog.getByRole("button", { name: "Tester et enregistrer" }).click();
  await expect(dialog.getByRole("status")).toContainText("Connecté : Compte démo");
  await expect(dialog.getByRole("status")).toContainText("Aucune propriété visible");
  expect(await noHScroll(page)).toBe(true);
});

test("comptes connectés : statut en texte, Tester / Remplacer la clé / Retirer ; connecteur unique sans formulaire", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: /^E-mail/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Comptes connectés")).toBeVisible();
  await expect(dialog.getByText("moi@exemple.com")).toBeVisible();
  await expect(dialog.getByText(/● Connecté/)).toBeVisible();
  for (const n of ["Tester", "Remplacer la clé", "Retirer"]) await expect(dialog.getByRole("button", { name: n })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Tester et enregistrer" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Remplacer la clé" }).click();
  await expect(dialog.getByText("Laisser vide pour garder la clé actuelle.")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^ntfy/ }).click();
  await expect(page.getByRole("dialog").getByText(/clé de l'instance a changé/)).toBeVisible();
});

test("bandeau SECRET invalide (R2) : formulaire absent, message visible", async ({ page }) => {
  await open(page, catalog({ vault: { ok: false, message: "Ajoutez une valeur SECRET de 32 caractères ou plus dans .env, puis redémarrez. Elle chiffre vos clés." } }));
  await expect(page.getByRole("alert").first()).toContainText("SECRET de 32 caractères");
  await page.getByRole("button", { name: /^Stripe/ }).click();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Tester et enregistrer" })).toHaveCount(0);
  expect(await noHScroll(page)).toBe(true);
});

test("mode démonstration : formulaires désactivés", async ({ page }) => {
  await open(page, catalog({ demo: true }));
  await page.getByRole("button", { name: /^Stripe/ }).click();
  await expect(page.getByRole("dialog").getByText("Désactivé en démonstration.")).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Tester et enregistrer" })).toHaveCount(0);
});
