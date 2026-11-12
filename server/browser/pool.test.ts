// B1 : moteur navigateur local — pages de test, refus des hôtes non autorisés, série, délai maximal, non-furtivité.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LAUNCH_ARGS, assertAllowedUrl, browserFingerprint, runs, withPage } from "./pool.ts";
import { startFixtures } from "./fixtures.ts";

test("B1 : hôtes — pages de test seulement sans bac à sable, adresses privées refusées avec", () => {
  assert.doesNotThrow(() => assertAllowedUrl("http://127.0.0.1:4100/composer", { sandbox: false, fixturePort: 4100 }));
  assert.throws(() => assertAllowedUrl("https://exemple.test/", { sandbox: false, fixturePort: 4100 }), /Bac à sable inactif/);
  assert.throws(() => assertAllowedUrl("http://127.0.0.1:4101/composer", { sandbox: false, fixturePort: 4100 }), /Bac à sable inactif/);
  assert.doesNotThrow(() => assertAllowedUrl("https://exemple.test/", { sandbox: true, fixturePort: 4100 }));
  for (const url of ["http://127.0.0.1:80/", "http://10.0.0.5/", "http://192.168.1.2/", "http://172.20.0.1/", "http://169.254.169.254/latest/meta-data", "http://metadata.google.internal/"]) {
    assert.throws(() => assertAllowedUrl(url, { sandbox: true, fixturePort: 4100 }), /refusée/, url);
  }
  assert.throws(() => assertAllowedUrl("file:///etc/passwd", { sandbox: true, fixturePort: 4100 }), /Protocole refusé/);
  // Aucun port de contrôle : arguments fixes, jamais --remote-debugging-port.
  assert.equal(LAUNCH_ARGS.some((a) => a.includes("remote-debugging-port")), false);
});

test("B1 : composeur factice — saisie, clic, page de succès avec adresse de preuve ; aucune furtivité", async () => {
  const f = await startFixtures();
  try {
    const proof = await withPage(`${f.url}/composer`, async (page) => {
      const fp = await browserFingerprint(page);
      assert.match(fp.ua as string, /HeadlessChrome/);
      assert.equal(fp.webdriver, true, "webdriver reste visible : aucune furtivité");
      await page.getByLabel("Titre").fill("Annonce de test");
      await page.getByLabel("Texte").fill("Contenu de test, aucune publication réelle.");
      await page.getByRole("button", { name: "Publier" }).click();
      await page.waitForURL(/\/published/);
      return page.locator("[data-post-url]").getAttribute("data-post-url");
    }, { fixturePort: f.port, sandbox: false, timeoutMs: 30_000 });
    assert.equal(proof, "https://exemple.test/posts/1");
    assert.equal(runs.active, 0, "aucune exécution restante");
  } finally { await f.close(); }
});

test("B1 : hôte non autorisé refusé avant tout lancement", async () => {
  const f = await startFixtures();
  try {
    await assert.rejects(withPage("https://exemple.test/", async () => 1, { fixturePort: f.port, sandbox: false }), /Bac à sable inactif/);
    assert.equal(runs.active, 0);
  } finally { await f.close(); }
});

test("B1 : une seule exécution à la fois", async () => {
  const f = await startFixtures();
  try {
    const run = () => withPage(`${f.url}/composer`, async (page) => {
      await page.waitForTimeout(300);
      return page.title();
    }, { fixturePort: f.port, sandbox: false, timeoutMs: 30_000 });
    const titles = await Promise.all([run(), run()]);
    assert.deepEqual(titles, ["Composeur factice", "Composeur factice"]);
    assert.equal(runs.max, 1, "jamais deux navigateurs simultanés");
    assert.equal(runs.active, 0);
  } finally { await f.close(); }
});

test("B1 : délai maximal — navigateur arrêté, compteur remis à zéro, exécution suivante possible", async () => {
  const f = await startFixtures();
  try {
    await assert.rejects(
      withPage(`${f.url}/composer`, async (page) => { await page.waitForTimeout(10_000); return "jamais"; }, { fixturePort: f.port, sandbox: false, timeoutMs: 400 }),
      /Délai maximal dépassé/,
    );
    assert.equal(runs.active, 0, "aucune exécution fantôme");
    const ok = await withPage(`${f.url}/composer`, async (page) => page.title(), { fixturePort: f.port, sandbox: false, timeoutMs: 30_000 });
    assert.equal(ok, "Composeur factice");
  } finally { await f.close(); }
});
