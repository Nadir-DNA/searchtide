// Lot 2 : plus aucune boîte native, état d'installation exposé, cinq outils d'installation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { login, startServer, tempDb } from "./test-server.ts";

const ROOT = new URL("../web/src", import.meta.url).pathname;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.(tsx?|jsx?)$/.test(e.name) ? [p] : [];
  });
}

test("1.8 : plus aucun prompt() ni confirm() natif dans web/src", () => {
  for (const file of sources(ROOT)) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /(^|[^.\w])prompt\(/, file);
    assert.doesNotMatch(text, /(^|[^.\w])confirm\(/, file);
  }
});

test("A2 : les onglets d'installation se limitent à HTML, Next.js, WordPress, Shopify et GTM", () => {
  const text = readFileSync(join(ROOT, "modules/analytics/index.tsx"), "utf8");
  const block = text.match(/options=\{\[\["html"[\s\S]*?\] as const\}/)?.[0] ?? "";
  for (const name of ["html", "next", "wordpress", "shopify", "gtm"]) assert.match(block, new RegExp(`"${name}"`));
  for (const absent of ["astro", "php"]) assert.doesNotMatch(block, new RegExp(`"${absent}"`), `${absent} retiré (13.4)`);
});

test("1.1/D3 : /api/sites/:id/setup-status expose la dernière visite et les refus, 404 sinon", async () => {
  const t = tempDb();
  const s = await startServer(t.path);
  try {
    const cookie = await login(s.base);
    const site = await (await fetch(`${s.base}/api/sites`, { method: "POST", headers: { Cookie: cookie, "content-type": "application/json" }, body: JSON.stringify({ domain: "statut.test" }) })).json();
    const empty = await (await fetch(`${s.base}/api/sites/${site.id}/setup-status`, { headers: { Cookie: cookie } })).json();
    assert.equal(empty.last_hit, null);
    assert.deepEqual(empty.refused, {});
    await fetch(`${s.base}/api/collect`, { method: "POST", headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0 Chrome/120" }, body: JSON.stringify({ site: "statut.test", url: "https://statut.test/" }) });
    const after = await (await fetch(`${s.base}/api/sites/${site.id}/setup-status`, { headers: { Cookie: cookie } })).json();
    assert.equal(typeof after.last_hit, "number");
    assert.equal((await fetch(`${s.base}/api/sites/inconnu/setup-status`, { headers: { Cookie: cookie } })).status, 404);
  } finally { s.stop(); t.done(); }
});
