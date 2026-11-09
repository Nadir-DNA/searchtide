// T9, CA14 de bout en bout : vrai serveur lancé dans un processus fils (base temporaire, port libre, aucun fournisseur).
// Vérifie que la session administrateur est bien reconnue par index.ts et que les clés d'API ne peuvent pas écrire.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const freePort = () => new Promise<number>((res) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => res(p)); }); });

test("CA14 (serveur réel) : clé d'API → 403 en écriture, 200 en lecture sans secret ; session admin reconnue", async () => {
  const dir = mkdtempSync(join(tmpdir(), "st-http-")); const port = await freePort(); const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server/index.ts"], { env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATABASE_PATH: join(dir, "t.db"), SECRET: "h".repeat(40), ADMIN_PASSWORD: "motdepasse-de-test", API_KEY: "cle-api-de-test-0001", DEMO: "", NODE_ENV: "test" }, stdio: "pipe" });
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* pas encore prêt */ } await new Promise((r) => setTimeout(r, 100)); }
    const key = { Authorization: "Bearer cle-api-de-test-0001", "content-type": "application/json" };
    const write = (m: string, p: string, h: Record<string, string>) => fetch(`${base}${p}`, { method: m, headers: h, body: m === "DELETE" ? undefined : JSON.stringify({ kind: "inexistant", values: {} }) });
    for (const [m, p] of [["POST", "/api/connections"], ["PATCH", "/api/connections/abc"], ["DELETE", "/api/connections/abc"], ["POST", "/api/connections/abc/test"]]) assert.equal((await write(m, p, key)).status, 403, `${m} ${p}`);
    const list = await fetch(`${base}/api/connections`, { headers: key });
    assert.equal(list.status, 200); assert.doesNotMatch(await list.text(), /secrets|fingerprint/);
    assert.equal((await fetch(`${base}/api/connectors`, { headers: key })).status, 200);
    assert.equal((await fetch(`${base}/api/connections`)).status, 401, "sans identifiant : refusé");
    // Session administrateur : le cookie ouvre l'écriture (le connecteur inconnu donne 400, pas 403)
    const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "motdepasse-de-test" }) });
    assert.equal(login.status, 200);
    const cookie = (login.headers.getSetCookie?.() ?? [login.headers.get("set-cookie") ?? ""]).map((c) => c.split(";")[0]).join("; ");
    const r = await write("POST", "/api/connections", { Cookie: cookie, "content-type": "application/json" });
    assert.equal(r.status, 400); assert.match((await r.json()).error, /Connecteur inconnu/);
    assert.equal((await (await fetch(`${base}/api/connectors`, { headers: { Cookie: cookie } })).json()).admin, true);
  } finally { child.kill(); rmSync(dir, { recursive: true, force: true }); }
});
