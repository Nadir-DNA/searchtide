// SPDX-License-Identifier: AGPL-3.0-only
// Fournisseur LinkedIn : échappement, charge utile, correspondance des erreurs — réseau simulé, aucun appel réel.
import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeCommentary, linkedin } from "./linkedin.ts";

const real = globalThis.fetch;
const reply = (status: number, headers: Record<string, string> = {}, body = "") => { globalThis.fetch = (async () => new Response(body, { status, headers })) as typeof fetch; };
test.afterEach(() => { globalThis.fetch = real; });

test("LinkedIn : les caractères réservés sont échappés (sinon le texte est tronqué)", () => {
  assert.equal(escapeCommentary("a (b) #seo _x_ [c] @d | e \\ f"), "a \\(b\\) \\#seo \\_x\\_ \\[c\\] \\@d \\| e \\\\ f");
  assert.equal(escapeCommentary("Bonjour le monde"), "Bonjour le monde");
});

test("LinkedIn : charge utile, en-têtes et adresse de preuve", async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  globalThis.fetch = (async (u: any, init: any) => { seen = { url: String(u), init }; return new Response("", { status: 201, headers: { "x-restli-id": "urn:li:share:123" } }); }) as typeof fetch;
  const r = await linkedin.publish({ text: "Bonjour (test)", media: [] }, "TOKEN", "abc");
  assert.deepEqual(r, { ok: true, url: "https://www.linkedin.com/feed/update/urn%3Ali%3Ashare%3A123/" });
  assert.equal(seen!.url, "https://api.linkedin.com/rest/posts");
  assert.equal((seen!.init.headers as any).Authorization, "Bearer TOKEN");
  const b = JSON.parse(String(seen!.init.body));
  assert.equal(b.author, "urn:li:person:abc");
  assert.equal(b.commentary, "Bonjour \\(test\\)");
  assert.equal(b.lifecycleState, "PUBLISHED");
});

test("LinkedIn : 401/403 = auth, 429 = débit, 422 = format, 5xx = à vérifier, coupure = à vérifier", async () => {
  for (const [status, kind] of [[401, "auth"], [403, "auth"], [429, "rate"], [422, "format"], [503, "to_verify"]] as const) {
    reply(status);
    const r = await linkedin.publish({ text: "x", media: [] }, "T", "a");
    assert.equal(r.ok, false); assert.equal((r as any).kind, kind, String(status));
  }
  globalThis.fetch = (async () => { throw new Error("délai dépassé"); }) as typeof fetch;
  assert.equal((await linkedin.publish({ text: "x", media: [] }, "T", "a") as any).kind, "to_verify");
  reply(201); // 201 sans identifiant : on ne prétend pas avoir une preuve
  assert.equal((await linkedin.publish({ text: "x", media: [] }, "T", "a") as any).kind, "to_verify");
});

test("LinkedIn : adresse d'autorisation avec les portées minimales", () => {
  process.env.LINKEDIN_CLIENT_ID = "cid";
  const u = new URL(linkedin.authUrl("https://i.test/cb", "S", "V"));
  assert.equal(u.searchParams.get("scope"), "openid profile w_member_social");
  assert.equal(u.searchParams.get("state"), "S");
  assert.equal(u.searchParams.get("redirect_uri"), "https://i.test/cb");
});
