// SPDX-License-Identifier: AGPL-3.0-only
// X, Facebook, Instagram, TikTok, YouTube : charges utiles, deux temps, correspondance des erreurs — réseaux simulés.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Media } from "../provider.ts";
import { x } from "./x.ts";
import { facebook, instagram } from "./meta.ts";
import { tiktok } from "./tiktok.ts";
import { youtube } from "./youtube.ts";

type Call = { url: string; method: string; body: any; headers: Record<string, string> };
const real = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = real; });

/** Réseau simulé : la première règle dont le motif correspond répond. */
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
const ok = (j: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(j), { status, headers });
const media = (mime: string, size = 10): Media => ({ id: "m1", mime, size, kind: mime.startsWith("video/") ? "video" : "image", bytes: () => Buffer.alloc(size, 1), publicUrl: () => "https://i.test/m/m1/9/sig" });

// ── X ──
test("X : texte seul → post, adresse de preuve, PKCE dans l'autorisation", async () => {
  process.env.X_CLIENT_ID = "xid";
  const u = new URL(x.authUrl("https://i.test/cb", "S", "verifier"));
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.ok(u.searchParams.get("scope")!.includes("media.write"));
  const calls = net([[/POST .*\/2\/tweets$/, () => ok({ data: { id: "77" } }, 201)]]);
  assert.deepEqual(await x.publish({ text: "Bonjour", media: [] }, "T", "u1"), { ok: true, url: "https://x.com/i/status/77" });
  assert.deepEqual(JSON.parse(calls[0].body), { text: "Bonjour" });
});

test("X : vidéo en traitement → pending, puis poll publie quand la vidéo est prête", async () => {
  let state = "in_progress";
  const calls = net([
    [/initialize$/, () => ok({ data: { id: "M1" } })],
    [/append$/, () => new Response(null, { status: 204 })],
    [/finalize$/, () => ok({ data: { id: "M1", processing_info: { state: "pending" } } })],
    [/GET .*command=STATUS/, () => ok({ data: { processing_info: { state } } })],
    [/POST .*\/2\/tweets$/, () => ok({ data: { id: "88" } }, 201)],
  ]);
  const r = await x.publish({ text: "Vidéo", media: [media("video/mp4", 1_500_000)] }, "T", "u1");
  assert.equal(r.ok, false); assert.equal((r as any).kind, "pending");
  assert.equal(calls.filter((c) => c.url.endsWith("/append")).length, 2, "1,5 Mo = deux morceaux de 1 Mo");
  const data = (r as any).data;
  assert.equal((await x.poll!(data, "T", "u1") as any).kind, "pending");
  state = "succeeded";
  assert.deepEqual(await x.poll!(data, "T", "u1"), { ok: true, url: "https://x.com/i/status/88" });
  assert.deepEqual(JSON.parse(calls.at(-1)!.body).media, { media_ids: ["M1"] });
});

test("X : 403 = refusé, 503 au post = à vérifier, échec d'envoi du média = relançable", async () => {
  net([[/tweets$/, () => ok({ detail: "duplicate content" }, 403)]]);
  assert.equal((await x.publish({ text: "a", media: [] }, "T", "u") as any).kind, "refused");
  net([[/tweets$/, () => ok({}, 503)]]);
  assert.equal((await x.publish({ text: "a", media: [] }, "T", "u") as any).kind, "to_verify");
  net([[/initialize$/, () => ok({}, 503)]]);
  assert.equal((await x.publish({ text: "a", media: [media("image/png")] }, "T", "u") as any).kind, "network");
});

// ── Facebook ──
test("Facebook : photos non publiées puis un seul post qui les rassemble", async () => {
  let n = 0;
  const calls = net([
    [/POST .*\/P1\/photos$/, () => ok({ id: `ph${++n}` })],
    [/POST .*\/P1\/feed$/, () => ok({ id: "P1_99" })],
  ]);
  const r = await facebook.publish({ text: "Album", media: [media("image/jpeg"), media("image/jpeg")] }, "PT", "P1");
  assert.deepEqual(r, { ok: true, url: "https://www.facebook.com/P1_99" });
  const photo = calls[0].body as FormData;
  assert.equal(photo.get("published"), "false");
  const feed = calls[2].body as URLSearchParams;
  assert.equal(feed.get("message"), "Album");
  assert.equal(feed.get("attached_media[1]"), JSON.stringify({ media_fbid: "ph2" }));
});

test("Facebook : jeton expiré (code 190) = auth ; vidéo mélangée à une image refusée avant l'envoi", async () => {
  net([[/feed$/, () => ok({ error: { code: 190, message: "expired" } }, 400)]]);
  assert.equal((await facebook.publish({ text: "a", media: [] }, "PT", "P1") as any).kind, "auth");
  assert.deepEqual(facebook.check!({ text: "a", media: [{ mime: "video/mp4", size: 1 }, { mime: "image/jpeg", size: 1 }] }), ["Facebook : une vidéo seule, ou des images"]);
});

test("Facebook : une Page par compte de publication à la connexion", async () => {
  process.env.FACEBOOK_CLIENT_ID = "fid"; process.env.FACEBOOK_CLIENT_SECRET = "fsec";
  net([
    [/oauth\/access_token\?.*code=/, () => ok({ access_token: "short" })],
    [/fb_exchange_token/, () => ok({ access_token: "long" })],
    [/me\/accounts/, () => ok({ data: [{ id: "P1", name: "Ma page", access_token: "PT1" }, { id: "P2", name: "Autre", access_token: "PT2" }] })],
  ]);
  const t = await facebook.exchange("code", "https://i.test/cb", "v");
  assert.deepEqual(t.map((a) => [a.accountId, a.name, a.accessToken]), [["P1", "Ma page", "PT1"], ["P2", "Autre", "PT2"]]);
});

// ── Instagram ──
test("Instagram : conteneur → pending ; poll attend FINISHED puis media_publish et permalien", async () => {
  let status = "IN_PROGRESS";
  const calls = net([
    [/POST .*\/IG\/media$/, () => ok({ id: "C1" })],
    [/GET .*\/C1\?/, () => ok({ status_code: status })],
    [/POST .*media_publish$/, () => ok({ id: "MED" })],
    [/GET .*\/MED\?/, () => ok({ permalink: "https://www.instagram.com/p/abc/" })],
  ]);
  const r = await instagram.publish({ text: "Légende", media: [media("image/jpeg")] }, "PT", "IG");
  assert.equal((r as any).kind, "pending");
  assert.equal((calls[0].body as URLSearchParams).get("image_url"), "https://i.test/m/m1/9/sig");
  assert.equal((await instagram.poll!((r as any).data, "PT", "IG") as any).kind, "pending");
  status = "FINISHED";
  assert.deepEqual(await instagram.poll!((r as any).data, "PT", "IG"), { ok: true, url: "https://www.instagram.com/p/abc/" });
});

test("Instagram : carrousel (enfants puis conteneur), refus du média, media_publish incertain = à vérifier", async () => {
  let k = 0;
  const calls = net([
    [/POST .*\/IG\/media$/, (c) => ok({ id: (c.body as URLSearchParams).get("media_type") === "CAROUSEL" ? "CAR" : `ch${++k}` })],
    [/GET .*\/(ch\d|CAR)\?/, () => ok({ status_code: "FINISHED" })],
    [/media_publish$/, () => ok({ error: { message: "boom" } }, 400)],
  ]);
  const r = await instagram.publish({ text: "C", media: [media("image/jpeg"), media("video/mp4")] }, "PT", "IG");
  assert.deepEqual((r as any).data.children, ["ch1", "ch2"]);
  assert.equal((calls[1].body as URLSearchParams).get("media_type"), "VIDEO");
  const next = await instagram.poll!((r as any).data, "PT", "IG");
  assert.deepEqual((next as any).data, { stage: "container", id: "CAR" });
  assert.equal((await instagram.poll!((next as any).data, "PT", "IG") as any).kind, "to_verify");
  net([[/GET .*\/C9\?/, () => ok({ status_code: "ERROR" })]]);
  assert.equal((await instagram.poll!({ stage: "container", id: "C9" }, "PT", "IG") as any).kind, "format");
  assert.deepEqual(instagram.check!({ text: "a", media: [] }), ["Instagram : au moins une image ou une vidéo"]);
});

// ── TikTok ──
test("TikTok : confidentialité vérifiée, envoi en un morceau, puis statut → adresse de la vidéo", async () => {
  let status = "PROCESSING_UPLOAD";
  const calls = net([
    [/creator_info/, () => ok({ data: { privacy_level_options: ["SELF_ONLY", "PUBLIC_TO_EVERYONE"], creator_username: "nadir" }, error: { code: "ok" } })],
    [/video\/init/, () => ok({ data: { publish_id: "PUB1", upload_url: "https://upload.tiktok.test/u" }, error: { code: "ok" } })],
    [/PUT https:\/\/upload/, () => new Response("", { status: 201 })],
    [/status\/fetch/, () => ok({ data: { status, publicaly_available_post_id: status === "PUBLISH_COMPLETE" ? ["7001"] : [] } })],
  ]);
  const r = await tiktok.publish({ text: "Vidéo", visibility: "public", media: [media("video/mp4", 100)] }, "T", "open");
  assert.equal((r as any).kind, "pending");
  const init = JSON.parse(calls[1].body);
  assert.equal(init.post_info.privacy_level, "PUBLIC_TO_EVERYONE");
  assert.deepEqual(init.source_info, { source: "FILE_UPLOAD", video_size: 100, chunk_size: 100, total_chunk_count: 1 });
  assert.equal(calls[2].headers["Content-Range"], "bytes 0-99/100");
  assert.equal((await tiktok.poll!((r as any).data, "T", "open") as any).kind, "pending");
  status = "PUBLISH_COMPLETE";
  assert.deepEqual(await tiktok.poll!((r as any).data, "T", "open"), { ok: true, url: "https://www.tiktok.com/@nadir/video/7001" });
});

test("TikTok : confidentialité non permise (application non auditée) refusée avant l'envoi ; FAILED = refusé", async () => {
  net([[/creator_info/, () => ok({ data: { privacy_level_options: ["SELF_ONLY"] }, error: { code: "ok" } })]]);
  const r = await tiktok.publish({ text: "a", visibility: "public", media: [media("video/mp4")] }, "T", "o");
  assert.equal((r as any).kind, "format"); assert.match((r as any).message, /SELF_ONLY/);
  net([[/status\/fetch/, () => ok({ data: { status: "FAILED", fail_reason: "spam" } })]]);
  assert.equal((await tiktok.poll!({ publishId: "P" }, "T", "o") as any).kind, "refused");
  assert.deepEqual(tiktok.check!({ text: "a", media: [{ mime: "image/jpeg", size: 1 }] }), ["TikTok : une seule vidéo (les photos viendront plus tard)"]);
});

// ── YouTube ──
test("YouTube : session resumable puis PUT → adresse de la vidéo ; titre et confidentialité transmis", async () => {
  const calls = net([
    [/POST .*uploadType=resumable/, () => new Response("", { status: 200, headers: { location: "https://upload.youtube.test/s1" } })],
    [/PUT https:\/\/upload\.youtube/, () => ok({ id: "vid42" })],
  ]);
  const r = await youtube.publish({ text: "Description", title: "Mon titre", visibility: "unlisted", media: [media("video/mp4", 50)] }, "T", "ch");
  assert.deepEqual(r, { ok: true, url: "https://www.youtube.com/watch?v=vid42" });
  const meta = JSON.parse(calls[0].body);
  assert.equal(meta.snippet.title, "Mon titre"); assert.equal(meta.status.privacyStatus, "unlisted");
  assert.equal(calls[0].headers["X-Upload-Content-Length"], "50");
});

test("YouTube : quota dépassé = quota ; coupure pendant le PUT = à vérifier", async () => {
  net([[/resumable/, () => ok({ error: { errors: [{ reason: "quotaExceeded" }] } }, 403)]]);
  assert.equal((await youtube.publish({ text: "a", media: [media("video/mp4")] }, "T", "c") as any).kind, "quota");
  net([
    [/resumable/, () => new Response("", { status: 200, headers: { location: "https://upload.youtube.test/s" } })],
    [/PUT/, () => { throw new Error("socket fermée"); }],
  ]);
  assert.equal((await youtube.publish({ text: "a", media: [media("video/mp4")] }, "T", "c") as any).kind, "to_verify");
});
