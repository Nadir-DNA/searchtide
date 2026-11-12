// SEC-05 origine/content-type, SEC-06 portée des clés, SEC-07 validation serveur des valeurs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { login, seed, startServer, tempDb } from "./test-server.ts";

const FAKE_KEY = "r" + "k_" + "test_FAKE0001";

const PASSWORD = "motdepasse-de-test";

test("SEC-05 : écritures cross-site refusées, JSON obligatoire, même origine acceptée", async () => {
  const t = tempDb();
  const s = await startServer(t.path);
  try {
    const cookie = await login(s.base);
    const site = await (await fetch(`${s.base}/api/sites`, { method: "POST", headers: { Cookie: cookie, "content-type": "application/json" }, body: JSON.stringify({ domain: "csrf.test" }) })).json();
    const purge = await fetch(`${s.base}/api/sites/${site.id}/purge`, { method: "POST", headers: { Cookie: cookie, "content-type": "application/json", Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" }, body: JSON.stringify({ before: "2020-01-01", expect: 0, dryRun: true }) });
    assert.equal(purge.status, 403, "origine étrangère refusée");
    const plain = await fetch(`${s.base}/api/login`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ password: PASSWORD }) });
    assert.equal(plain.status, 415, "login en text/plain refusé");
    const same = await fetch(`${s.base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) });
    assert.equal(same.status, 200, "même origine en JSON acceptée");
  } finally { s.stop(); t.done(); }
});

test("SEC-06 : clés limitées à la liste blanche, routes admin 403, démo anonyme 403", async () => {
  const t = tempDb();
  seed(t.path, `import "@server/jobs.ts";
    import { db } from "@server/db.ts";
    db.prepare("INSERT INTO jobs (id, module, every, error, fails) VALUES ('x', 'projets', '6h', 'sujet-ntfy-secret ${FAKE_KEY}', 0)").run();`);
  const s = await startServer(t.path, { API_KEY_READ: "cle-lecture-test-0001", NTFY_TOPIC: "sujet-ntfy-secret" });
  try {
    const admin = { Cookie: await login(s.base) };
    const full = { Authorization: "Bearer cle-api-de-test-0001" };
    const ro = { Authorization: "Bearer cle-lecture-test-0001" };
    const agent = await (await fetch(`${s.base}/api/agents`, { method: "POST", headers: { ...admin, "content-type": "application/json" }, body: JSON.stringify({ name: "sec06", read_only: true, all_projects: true }) })).json();
    const ag = { Authorization: `Bearer ${agent.key}` };
    for (const h of [full, ro, ag]) {
      assert.equal((await fetch(`${s.base}/api/sites`, { headers: h })).status, 200, "lecture autorisée");
      for (const path of ["/api/ops", "/api/contacts", "/api/modules", "/api/diagnostic", "/api/2fa", "/api/agents", "/api/connections"]) {
        assert.equal((await fetch(`${s.base}${path}`, { headers: h })).status, 403, `${path} réservé admin`);
      }
    }
    assert.equal((await fetch(`${s.base}/api/ops`, { headers: admin })).status, 200);
    assert.equal((await fetch(`${s.base}/api/contacts`, { headers: admin })).status, 200);
    // SEC-06b : clé API complète ET agent complet ne suppriment ni ne modifient par REST.
    const project = await (await fetch(`${s.base}/api/projects`, { method: "POST", headers: { ...admin, "content-type": "application/json" }, body: JSON.stringify({ name: "Protégé", all_projects: true }) })).json();
    const site = await (await fetch(`${s.base}/api/sites`, { method: "POST", headers: { ...admin, "content-type": "application/json" }, body: JSON.stringify({ domain: "protege.test" }) })).json();
    const ind = await (await fetch(`${s.base}/api/projects/${project.id}/indicators`, { method: "POST", headers: { ...admin, "content-type": "application/json" }, body: JSON.stringify({ label: "Ventes", mode: "daily", source: "manual" }) })).json();
    const write = await (await fetch(`${s.base}/api/agents`, { method: "POST", headers: { ...admin, "content-type": "application/json" }, body: JSON.stringify({ name: "complet", read_only: false, all_projects: true }) })).json();
    const complete = { Authorization: `Bearer ${write.key}`, "content-type": "application/json" };
    for (const [label, headers] of [["clé API", full], ["agent complet", complete]] as const) {
      assert.equal((await fetch(`${s.base}/api/projects/${project.id}`, { method: "DELETE", headers })).status, 403, `${label} : DELETE projet`);
      assert.equal((await fetch(`${s.base}/api/sites/${site.id}`, { method: "DELETE", headers })).status, 403, `${label} : DELETE site`);
      assert.equal((await fetch(`${s.base}/api/indicators/${ind.id}`, { method: "DELETE", headers })).status, 403, `${label} : DELETE indicateur`);
      assert.equal((await fetch(`${s.base}/api/indicators/${ind.id}`, { method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ source: "http", config: { url: "https://example.test", path: "v" } }) })).status, 403, `${label} : source`);
      assert.equal((await fetch(`${s.base}/api/projects/${project.id}`, { method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ name: "Renommé", all_projects: true }) })).status, 403, `${label} : PATCH projet`);
      assert.equal((await fetch(`${s.base}/api/indicators/${ind.id}/value`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ day: "2026-01-02", value: 3 }) })).status, 200, `${label} : valeur autorisée`);
    }
    assert.equal((await (await fetch(`${s.base}/api/projects/${project.id}`, { headers: admin })).json()).name, "Protégé");
    assert.ok((await (await fetch(`${s.base}/api/projects/${project.id}?days=400`, { headers: admin })).json()).indicators[0].series.some((x: any) => x.value === 3));
    const jobs = await (await fetch(`${s.base}/api/jobs`, { headers: full })).text();
    assert.match(jobs, /•••|x/, "tâche visible");
    assert.doesNotMatch(jobs, new RegExp(`sujet-ntfy-secret|${FAKE_KEY}`), "erreurs épurées (scrub)");
  } finally { s.stop(); }
  const d = await startServer(t.path, { DEMO: "1" });
  try {
    assert.equal((await fetch(`${d.base}/api/sites`)).status, 200, "lecture ouverte en démo");
    assert.equal((await fetch(`${d.base}/api/ops`)).status, 403, "admin-only en démo");
    assert.equal((await fetch(`${d.base}/api/contacts`)).status, 403, "CRM en démo");
  } finally { d.stop(); t.done(); }
});

test("SEC-07 : jours et valeurs invalides refusés sans écriture ; lot 366 en transaction", async () => {
  const t = tempDb();
  const s = await startServer(t.path);
  try {
    const cookie = await login(s.base);
    const h = { Cookie: cookie, "content-type": "application/json" };
    const p = await (await fetch(`${s.base}/api/projects`, { method: "POST", headers: h, body: JSON.stringify({ name: "Valeurs", all_projects: true }) })).json();
    const ind = await (await fetch(`${s.base}/api/projects/${p.id}/indicators`, { method: "POST", headers: h, body: JSON.stringify({ label: "Ventes", mode: "daily", source: "manual" }) })).json();
    const post = (body: unknown) => fetch(`${s.base}/api/indicators/${ind.id}/value`, { method: "POST", headers: h, body: JSON.stringify(body) });
    for (const day of ["2026-99-99", "2026-02-30", "n'importe quoi", "1999-12-31", "2099-01-01"]) assert.equal((await post({ day, value: 1 })).status, 400, day);
    for (const value of [1e30, "Infinity", "NaN", null]) assert.equal((await post({ day: "2026-01-02", value })).status, 400, String(value));
    assert.equal((await post({ day: "2026-01-02", value: 12.5 })).status, 200);
    const project = await (await fetch(`${s.base}/api/projects/${p.id}?days=365`, { headers: h })).json();
    const series = project.indicators[0].series.filter((x: { value: number | null }) => x.value != null);
    assert.deepEqual(series.map((x: { day: string; value: number }) => [x.day, x.value]), [["2026-01-02", 12.5]], "aucune écriture invalide");

    const start = Date.UTC(2025, 0, 1);
    const many = Array.from({ length: 366 }, (_, i) => ({ day: new Date(start + i * 86_400_000).toISOString().slice(0, 10), value: i + 1 }));
    assert.equal((await fetch(`${s.base}/api/indicators/${ind.id}/values`, { method: "POST", headers: h, body: JSON.stringify({ values: many }) })).status, 200);
    assert.equal((await fetch(`${s.base}/api/indicators/${ind.id}/values`, { method: "POST", headers: h, body: JSON.stringify({ values: [...many, { day: "2025-12-31", value: 1 }] }) })).status, 400, "367 refusé");
    assert.equal((await fetch(`${s.base}/api/indicators/${ind.id}/values`, { method: "POST", headers: h, body: JSON.stringify({ values: [{ day: "2026-02-30", value: 1 }] }) })).status, 400);
  } finally { s.stop(); t.done(); }
});

test("SEC-01 : /api/ops/backup-passphrase n'est pas un oracle du mot de passe", async () => {
  const t = tempDb();
  const s = await startServer(t.path, { TRUST_PROXY: "1" });
  try {
    const cookie = await login(s.base);
    const h = { Cookie: cookie, "content-type": "application/json", "x-forwarded-for": "198.51.100.230" };
    for (let i = 0; i < 5; i++) assert.equal((await fetch(`${s.base}/api/ops/backup-passphrase`, { method: "POST", headers: h, body: JSON.stringify({ password: "faux", passphrase: "x".repeat(20) }) })).status, 400);
    assert.equal((await fetch(`${s.base}/api/ops/backup-passphrase`, { method: "POST", headers: h, body: JSON.stringify({ password: "faux", passphrase: "x".repeat(20) }) })).status, 429);
    assert.equal((await fetch(`${s.base}/api/ops/backup-passphrase`, { method: "POST", headers: h, body: JSON.stringify({ password: "motdepasse-de-test", passphrase: "phrase-de-sauvegarde-solide" }) })).status, 429, "bon mot de passe refusé pendant le blocage");
    const key = { Authorization: "Bearer cle-api-de-test-0001" };
    assert.equal((await fetch(`${s.base}/api/ops/backup-passphrase`, { headers: key })).status, 403);
  } finally { s.stop(); t.done(); }
});
