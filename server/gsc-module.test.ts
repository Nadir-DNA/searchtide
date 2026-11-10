import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db.ts";
import { connections } from "./connections.ts";
import { GOOGLE_JSON } from "./connectors/fixtures.ts";
import { saveProject } from "./projects.ts";
import { setProjectModule } from "./modules/state.ts";

process.env.SECRET = "g".repeat(40);
import { convertGoogleEnv, gscConfigured, gscPropertyFor, serviceAccount } from "./gsc.ts";

test("google : sans connexion, la variable d'environnement n'est plus lue", () => {
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = GOOGLE_JSON;
  assert.equal(serviceAccount(), null);
  assert.equal(gscConfigured(), false);
});

test("google : la variable d'environnement devient une connexion, une seule fois", () => {
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = GOOGLE_JSON;
  assert.equal(convertGoogleEnv(), "converti");
  assert.equal(convertGoogleEnv(), "deja-connecte");
  assert.equal(connections("google").length, 1);
  assert.ok(serviceAccount()?.client_email);
  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
});

test("google : sans variable, rien à convertir", () => {
  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  assert.equal(convertGoogleEnv(), connections("google").length ? "deja-connecte" : "absent");
});

test("google : la propriété du projet prime sur celle du site", () => {
  db.prepare("INSERT INTO sites (id, domain, name, gsc_property, created_at) VALUES ('ga', 'a.fr', 'a.fr', 'sc-domain:a.fr', 0)").run();
  const p = saveProject(null, { name: "A", sites: ["a.fr"] })!;
  assert.equal(gscPropertyFor("a.fr", p.id), "sc-domain:a.fr");
  setProjectModule(p.id, "google", true, { gsc_property: { "a.fr": "https://a.fr/" } });
  assert.equal(gscPropertyFor("a.fr", p.id), "https://a.fr/");
  assert.equal(gscPropertyFor("a.fr"), "https://a.fr/"); // sans projet : celle d'un projet qui contient le site
  assert.equal(gscPropertyFor("inconnu.fr"), null);
});
