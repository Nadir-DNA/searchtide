// A9 : rapport client — lien secret révocable, page publique sans session, texte échappé, marque appliquée.
import { test } from "node:test";
import assert from "node:assert/strict";
import { login, startServer, tempDb } from "./test-server.ts";

test("rapport client : marque, lien partagé lisible sans session, révocation, injection échappée", async () => {
  const t = tempDb();
  const s = await startServer(t.path);
  try {
    const cookie = await login(s.base);
    const call = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => fetch(`${s.base}${path}`, { method, headers: { "content-type": "application/json", Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const p = await (await call("/api/projects", { name: "Boutique <script>alert(1)</script>" })).json();
    assert.equal((await call("/api/report-brand", { name: "Agence Nova", color: "pas une couleur" }, "PUT")).status, 400);
    assert.equal((await call("/api/report-brand", { name: "Agence Nova", color: "#2255aa", footer: "nova.fr", logo: "data:text/html;base64,PGI+" }, "PUT")).status, 400, "seules les images sont acceptées");
    await call("/api/report-brand", { name: "Agence Nova", color: "#2255aa", footer: "nova.fr" }, "PUT");
    const share = await (await call(`/api/projects/${p.id}/report-shares`, { label: "Client A", days: 90 })).json();
    assert.match(share.token, /^[\w-]{32}$/);

    const page = await fetch(`${s.base}/r/${share.token}`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    assert.equal(page.headers.get("x-robots-tag"), "noindex, nofollow");
    const html = await page.text();
    assert.match(html, /Agence Nova/); assert.match(html, /--accent:#2255aa/); assert.match(html, /nova\.fr/);
    assert.ok(!html.includes("<script>alert(1)</script>") && html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "nom du projet échappé");
    assert.equal((await (await call(`/api/projects/${p.id}/report-shares`)).json())[0].views, 1);

    await call(`/api/report-shares/${share.token}`, undefined, "DELETE");
    assert.equal((await fetch(`${s.base}/r/${share.token}`)).status, 404, "révoqué");
    assert.equal((await fetch(`${s.base}/r/inconnu`)).status, 404);
    assert.equal((await fetch(`${s.base}/api/projects/${p.id}/report-shares`, { headers: { authorization: "Bearer cle-api-de-test-0001" } })).status, 403, "une clé d'API ne lit pas les liens");
  } finally { s.stop(); t.done(); }
});
