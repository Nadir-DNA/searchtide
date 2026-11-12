// L1 par l'interface : clé limitée → demande → approbation admin → exécution unique → journal.
// Vrai serveur, vrai navigateur ; aucune publication, aucun appel externe.
import { test, expect, type Page } from "@playwright/test";

async function login(page: Page) {
  await page.goto("/");
  await page.locator('input[name="password"]').fill("e2e-mot-de-passe");
  await page.keyboard.press("Enter");
  await page.waitForLoadState("networkidle");
}

async function project(page: Page, name: string) {
  const r = await page.request.post("/api/projects", { data: { name } });
  expect(r.status()).toBe(201);
  return (await r.json()).id as string;
}

async function limitedKey(page: Page, name: string, projects: string[], readOnly = false) {
  const r = await page.request.post("/api/agents", { data: { name, read_only: readOnly, all_projects: false, scopes: projects.map((id) => ({ project_id: id, mode: readOnly ? "read" : "write" })) } });
  expect(r.status()).toBe(201);
  return (await r.json()).key as string;
}

test("L1 interface : clé limitée → demande → approbation admin → exécution une seule fois → journal", async ({ page }) => {
  await login(page);
  const p1 = await project(page, "Projet approuvé");
  const p2 = await project(page, "Projet hors portée");
  const ind = await (await page.request.post(`/api/projects/${p1}/indicators`, { data: { label: "CA approuvé", mode: "total", source: "manual", config: { role: "revenue" } } })).json();
  const key = await limitedKey(page, "Agent demande", [p1]);
  const k = { Authorization: `Bearer ${key}`, "content-type": "application/json" };

  // 1. La clé limitée propose une modification ; elle ne peut pas l'exécuter seule.
  const asked = await page.request.post("/api/approvals", {
    headers: k,
    data: { action: "indicator_source", project_id: p1, target_id: ind.id, payload: { config: { role: "contacts" } } },
  });
  expect(asked.status()).toBe(201);
  const approval = await asked.json();
  expect((await page.request.patch(`/api/indicators/${ind.id}`, { headers: k, data: { config: { role: "contacts" } } })).status()).toBe(403);

  // 2. L'administrateur voit la demande lisible et approuve dans l'écran dédié.
  await page.goto("/?view=approvals");
  const card = page.getByTestId(`approval-${approval.id}`);
  await expect(card).toBeVisible();
  await expect(card).toContainText("Modifier un indicateur");
  await expect(card).toContainText("CA approuvé");
  await expect(card).toContainText("Projet approuvé");
  await expect(card).toContainText("En attente");
  await card.getByText("Voir la charge utile").click();
  await expect(card.locator("pre").first()).toContainText("contacts");
  await card.getByRole("button", { name: "Approuver" }).click();
  await expect(card).toContainText("Approuvée");

  // 3. La clé exécute une seule fois, avec la charge exacte approuvée.
  const done = await page.request.patch(`/api/indicators/${ind.id}`, { headers: { ...k, "x-approval-id": approval.id }, data: { config: { role: "contacts" } } });
  expect(done.status()).toBe(200);
  expect((await done.json()).config.role).toBe("contacts");
  const replay = await page.request.patch(`/api/indicators/${ind.id}`, { headers: { ...k, "x-approval-id": approval.id }, data: { config: { role: "contacts" } } });
  expect(replay.status()).toBe(409);                                   // usage unique
  expect(await replay.text()).not.toContain("contacts");               // échec visible, aucune fuite

  // 4. Consommation et journal visibles.
  await page.reload();
  await expect(page.getByTestId(`approval-${approval.id}`)).toContainText("Consommée");
  await expect(page.getByText("approval_consumed").first()).toBeVisible();

  // 5. Hors portée : 404 uniforme, aucune fuite d'existence, et la demande n'est pas créée.
  expect((await page.request.get(`/api/projects/${p2}`, { headers: k })).status()).toBe(404);
  expect((await page.request.post("/api/approvals", { headers: k, data: { action: "indicator_source", project_id: p2, target_id: ind.id, payload: {} } })).status()).toBe(404);
});

test("L1 interface : clé en lecture seule — message « peut proposer, ne peut pas exécuter »", async ({ page }) => {
  await login(page);
  const p = await project(page, "Projet lecture");
  const key = await limitedKey(page, "Agent lecture", [p], true);
  const k = { Authorization: `Bearer ${key}`, "content-type": "application/json" };
  const ind = await (await page.request.post(`/api/projects/${p}/indicators`, { data: { label: "CA lecture", mode: "total", source: "manual", config: { role: "revenue" } } })).json();

  // Elle peut proposer…
  expect((await page.request.post("/api/approvals", { headers: k, data: { action: "indicator_source", project_id: p, target_id: ind.id, payload: { config: { role: "contacts" } } } })).status()).toBe(201);
  // …mais jamais exécuter, même avec une approbation valide.
  const asked = await (await page.request.post("/api/approvals", { headers: k, data: { action: "indicator_source", project_id: p, target_id: ind.id, payload: { config: { role: "contacts" } } } })).json();
  const list = await (await page.request.get("/api/approvals")).json();
  await page.request.post(`/api/approvals/${asked.id}/approve`);
  expect(list.length).toBeGreaterThan(0);
  expect((await page.request.patch(`/api/indicators/${ind.id}`, { headers: { ...k, "x-approval-id": asked.id }, data: { config: { role: "contacts" } } })).status()).toBe(403);

  await page.goto("/?view=agents");
  await expect(page.getByText("Cette clé peut proposer une modification ; elle ne peut pas l'exécuter : l'administrateur doit l'approuver.")).toBeVisible();
});

test("L1 interface : création avec portée explicite, clé affichée une fois, modification de portée", async ({ page }) => {
  await login(page);
  const p1 = await project(page, "Projet choisi A");
  const p2 = await project(page, "Projet choisi B");

  await page.goto("/?view=agents");
  await expect(page.getByText(/avertissement : accès à tous les projets/).first()).toBeVisible();                       // avertissement explicite
  const readOnly = page.getByRole("checkbox", { name: /Lecture seule/ });
  await expect(readOnly).toBeChecked();                                                 // lecture seule par défaut

  await page.locator('input[name="name"]').fill("Agent interface");
  await page.getByRole("checkbox", { name: /Projet choisi A/ }).check();
  await page.getByRole("button", { name: "Créer la clé" }).click();
  await expect(page.getByText("Cette clé ne s'affichera plus")).toBeVisible();           // affichée une seule fois
  await page.getByRole("button", { name: "J'ai copié, fermer" }).click();
  await expect(page.getByText("Cette clé ne s'affichera plus")).toHaveCount(0);

  // La clé créée est en lecture seule et limitée au projet A.
  const keys = await (await page.request.get("/api/agents")).json();
  const created = keys.find((x: any) => x.name === "Agent interface");
  expect(created.read_only).toBe(1);
  expect(created.all_projects).toBe(0);
  expect(created.scopes.map((s: any) => s.project_id)).toEqual([p1]);

  // Modification de portée par l'interface : ajout du projet B en écriture (clé complète distincte).
  const full = await (await page.request.post("/api/agents", { data: { name: "Agent portée", read_only: false, all_projects: false, scopes: [{ project_id: p1, mode: "read" }] } })).json();
  await page.reload();
  const row = page.locator("tr", { hasText: "Agent portée" });
  await row.getByRole("button", { name: "Portée" }).click();
  await page.getByRole("group", { name: "Portée de Agent portée" }).getByRole("checkbox", { name: /Projet choisi B/ }).check();
  await page.getByRole("button", { name: "Enregistrer la portée" }).click();
  await expect(page.locator("tr", { hasText: "Agent portée" })).toContainText("2 projets");
  const after = await (await page.request.get("/api/agents")).json();
  const changed = after.find((x: any) => x.id === full.id);
  expect(changed.scopes).toHaveLength(2);
  expect(changed.scopes.find((s: any) => s.project_id === p2)?.mode).toBe("read");
});
