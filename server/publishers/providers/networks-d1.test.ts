// SPDX-License-Identifier: AGPL-3.0-only
// Pinterest, Reddit, Google Business Profile : charges utiles, comptes ouverts à la connexion, erreurs — réseaux simulés.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Media } from "../provider.ts";
import { pinterest } from "./pinterest.ts";
import { reddit } from "./reddit.ts";
import { gbp } from "./gbp.ts";

type Call = { url: string; method: string; body: any; headers: Record<string, string> };
const real = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = real; });
function net(rules: [RegExp, (c: Call) => Response | Promise<Response>][]) {
  const calls: Call[] = [];
  globalThis.fetch = (async (u: any, i: any = {}) => {
    const c = { url: String(u), method: i.method ?? "GET", body: i.body, headers: i.headers ?? {} };
    calls.push(c);
    const rule = rules.find(([re]) => re.test(`${c.method} ${c.url}`));
    if (!rule) throw new Error(`appel inattendu : ${c.method} ${c.url}`);
    return rule[1](c);
  }) as typeof fetch;
  return calls;
}
const ok = (j: unknown, status = 200) => new Response(JSON.stringify(j), { status });
const img = (size = 10): Media => ({ id: "m1", mime: "image/jpeg", size, kind: "image", bytes: () => Buffer.from("abc"), publicUrl: () => "https://i.test/m/m1" });

// ── Pinterest ──
test("Pinterest : un compte par tableau à la connexion", async () => {
  process.env.PINTEREST_CLIENT_ID = "pid"; process.env.PINTEREST_CLIENT_SECRET = "ps";
  net([
    [/POST .*\/oauth\/token$/, () => ok({ access_token: "T", refresh_token: "R", expires_in: 3600 })],
    [/GET .*\/user_account$/, () => ok({ username: "atelier" })],
    [/GET .*\/boards/, () => ok({ items: [{ id: "b1", name: "Recettes" }, { id: "b2", name: "Déco" }] })],
  ]);
  const t = await pinterest.exchange("code", "https://i.test/cb", "v");
  assert.deepEqual(t.map((x) => [x.accountId, x.name]), [["b1", "@atelier · Recettes"], ["b2", "@atelier · Déco"]]);
  assert.equal(new URL(pinterest.authUrl("https://i.test/cb", "S", "v")).searchParams.get("scope"), "boards:read,pins:read,pins:write,user_accounts:read");
});

test("Pinterest : épingle sur le tableau, image en base64, lien repris du texte ; image obligatoire", async () => {
  const calls = net([[/POST .*\/v5\/pins$/, () => ok({ id: "555" }, 201)]]);
  const r = await pinterest.publish({ text: "Notre tarte https://monsite.fr/tarte", title: "Tarte", media: [img()] }, "T", "b1");
  assert.deepEqual(r, { ok: true, url: "https://www.pinterest.com/pin/555/" });
  const body = JSON.parse(calls[0].body);
  assert.equal(body.board_id, "b1"); assert.equal(body.link, "https://monsite.fr/tarte");
  assert.equal(body.media_source.source_type, "image_base64"); assert.equal(body.media_source.data, Buffer.from("abc").toString("base64"));
  assert.ok(pinterest.check!({ text: "x", media: [] }).some((m) => /une image/.test(m)));
});

test("Pinterest : 429 = limite ; 500 au geste final = à vérifier ; statistiques d'épingle", async () => {
  net([[/POST .*\/pins$/, () => ok({}, 429)]]);
  assert.equal((await pinterest.publish({ text: "a", media: [img()] }, "T", "b1") as any).kind, "rate");
  net([[/POST .*\/pins$/, () => ok({}, 503)]]);
  assert.equal((await pinterest.publish({ text: "a", media: [img()] }, "T", "b1") as any).kind, "to_verify");
  net([[/GET .*\/pins\/555\/analytics/, () => ok({ all: { summary_metrics: { IMPRESSION: 120, SAVE: 7, PIN_CLICK: 3 } } })]]);
  assert.deepEqual(await pinterest.postStats!(["https://www.pinterest.com/pin/555/"], "T", "b1"), { "https://www.pinterest.com/pin/555/": { impressions: 120, shares: 7, views: 3 } });
});

// ── Reddit ──
test("Reddit : post texte dans le subreddit du compte, User-Agent identifiable, adresse de preuve", async () => {
  const calls = net([[/POST .*\/api\/submit$/, () => ok({ json: { errors: [], data: { url: "https://www.reddit.com/r/entrepreneur/comments/abc12/mon_post/" } } })]]);
  const r = await reddit.publish({ text: "Bonjour à tous", title: "Retour d'expérience", media: [], target: "entrepreneur" }, "T", "moi");
  assert.deepEqual(r, { ok: true, url: "https://www.reddit.com/r/entrepreneur/comments/abc12/mon_post/" });
  const b = new URLSearchParams(calls[0].body);
  assert.equal(b.get("sr"), "entrepreneur"); assert.equal(b.get("kind"), "self"); assert.equal(b.get("text"), "Bonjour à tous");
  assert.match(calls[0].headers["User-Agent"], /searchtide/);
});

test("Reddit : texte réduit à une adresse = post lien ; sans subreddit = refusé avant l'envoi ; RATELIMIT = limite", async () => {
  const calls = net([[/POST .*\/api\/submit$/, () => ok({ json: { errors: [], data: { url: "https://www.reddit.com/r/a_b/comments/z9/x/" } } })]]);
  await reddit.publish({ text: " https://monsite.fr/article ", title: "Article", media: [], target: "a_b" }, "T", "moi");
  const b = new URLSearchParams(calls[0].body);
  assert.equal(b.get("kind"), "link"); assert.equal(b.get("url"), "https://monsite.fr/article");
  assert.equal((await reddit.publish({ text: "x", title: "t", media: [] }, "T", "moi") as any).kind, "format");
  net([[/POST .*\/api\/submit$/, () => ok({ json: { errors: [["RATELIMIT", "Réessayez dans 9 minutes", "ratelimit"]] } })]]);
  assert.equal((await reddit.publish({ text: "x", title: "t", media: [], target: "a_b" }, "T", "moi") as any).kind, "rate");
  assert.ok(reddit.check!({ text: "x", media: [] }).some((m) => /titre requis/.test(m)));
});

test("Reddit : commentaire sous un post, score et commentaires par post", async () => {
  const calls = net([
    [/POST .*\/api\/comment$/, () => ok({ json: { errors: [], data: { things: [{ data: { permalink: "/r/a_b/comments/z9/x/c1/" } }] } } })],
    [/GET .*\/api\/info\?id=t3_z9/, () => ok({ data: { children: [{ data: { name: "t3_z9", score: 42, num_comments: 5 } }] } })],
  ]);
  assert.deepEqual(await reddit.reply!("https://www.reddit.com/r/a_b/comments/z9/x/", "Merci !", "T", "moi"), { ok: true, url: "https://www.reddit.com/r/a_b/comments/z9/x/c1/" });
  assert.equal(new URLSearchParams(calls[0].body).get("thing_id"), "t3_z9");
  assert.deepEqual(await reddit.postStats!(["https://www.reddit.com/r/a_b/comments/z9/x/"], "T", "moi"), { "https://www.reddit.com/r/a_b/comments/z9/x/": { likes: 42, comments: 5 } });
});

// ── Google Business Profile ──
test("Google Business Profile : une fiche par compte, accès refusé expliqué", async () => {
  process.env.GOOGLE_BUSINESS_CLIENT_ID = "g"; process.env.GOOGLE_BUSINESS_CLIENT_SECRET = "s";
  net([
    [/oauth2\.googleapis\.com\/token/, () => ok({ access_token: "T", refresh_token: "R", expires_in: 3600 })],
    [/v1\/accounts$/, () => ok({ accounts: [{ name: "accounts/1" }] })],
    [/accounts\/1\/locations/, () => ok({ locations: [{ name: "locations/9", title: "Boulangerie Martin" }] })],
  ]);
  const t = await gbp.exchange("c", "https://i.test/cb", "v");
  assert.deepEqual(t.map((x) => [x.accountId, x.name]), [["accounts/1/locations/9", "Boulangerie Martin"]]);
  net([[/oauth2\.googleapis\.com\/token/, () => ok({ access_token: "T" })], [/v1\/accounts$/, () => ok({}, 403)]]);
  await assert.rejects(gbp.exchange("c", "https://i.test/cb", "v"), /demandez l'accès/);
});

test("Google Business Profile : actualité avec lien d'action et photo publique ; vues de la fiche additionnées", async () => {
  const calls = net([[/POST .*v4\/accounts\/1\/locations\/9\/localPosts$/, () => ok({ name: "accounts/1/locations/9/localPosts/p1", searchUrl: "https://local.google.com/place?id=1&use=posts&lpsid=p1" })]]);
  const r = await gbp.publish({ text: "Nouvelle carte https://boulangerie.fr/carte", media: [img()] }, "T", "accounts/1/locations/9");
  assert.deepEqual(r, { ok: true, url: "https://local.google.com/place?id=1&use=posts&lpsid=p1" });
  const b = JSON.parse(calls[0].body);
  assert.deepEqual(b.callToAction, { actionType: "LEARN_MORE", url: "https://boulangerie.fr/carte" });
  assert.equal(b.media[0].sourceUrl, "https://i.test/m/m1");
  net([[/fetchMultiDailyMetricsTimeSeries/, () => ok({ multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: [
    { timeSeries: { datedValues: [{ value: "10" }, { value: "5" }, {}] } }, { timeSeries: { datedValues: [{ value: "2" }] } }] }] })]]);
  assert.deepEqual(await gbp.stats!("T", "accounts/1/locations/9"), { views: 17 });
});
