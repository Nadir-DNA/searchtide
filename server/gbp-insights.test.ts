// A8 : fiches Google — avis et note, actions jour par jour, réponse à un avis, avis sans réponse dans « À traiter ».
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db.ts";
import { createAccount } from "./publishers/queue.ts";
import { collectLocation, locationsReport, replyReview } from "./gbp-insights.ts";
import { today } from "./today.ts";

const project = "proj-gbp";
db.prepare("INSERT INTO projects (id, name, crm_key, sites, created_at) VALUES (?, 'Boulangerie', 'boul', '[]', 0)").run(project);
const acc = createAccount({ project: "boul", network: "gbp", label: "Boulangerie Martin" }) as any;
db.prepare("UPDATE pub_accounts SET connection_id = 'c-gbp' WHERE id = ?").run(acc.id);
const account = () => db.prepare("SELECT * FROM pub_accounts WHERE id = ?").get(acc.id) as any;
const creds = async () => ({ ok: true as const, token: "T", accountId: "accounts/1/locations/9" });
const recent = new Date(Date.now() - 2 * 86_400_000).toISOString();

test("relevé : avis (auteur, note, réponse), note moyenne, actions additionnées par jour", async () => {
  const calls: string[] = [];
  const f = (async (u: any) => {
    const url = String(u); calls.push(url);
    if (url.includes("/reviews")) return new Response(JSON.stringify({ averageRating: 4.3, totalReviewCount: 57, reviews: [
      { reviewId: "r1", reviewer: { displayName: "Paul" }, starRating: "TWO", comment: "Pain rassis", createTime: recent },
      { reviewId: "r2", reviewer: { isAnonymous: true }, starRating: "FIVE", createTime: recent, reviewReply: { comment: "Merci !", updateTime: recent } }] }));
    return new Response(JSON.stringify({ multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: [
      { dailyMetric: "CALL_CLICKS", timeSeries: { datedValues: [{ date: { year: 2026, month: 11, day: 10 }, value: "3" }] } },
      { dailyMetric: "BUSINESS_IMPRESSIONS_MOBILE_MAPS", timeSeries: { datedValues: [{ date: { year: 2026, month: 11, day: 10 }, value: "100" }] } },
      { dailyMetric: "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH", timeSeries: { datedValues: [{ date: { year: 2026, month: 11, day: 10 }, value: "20" }] } }] }] }));
  }) as typeof fetch;
  assert.deepEqual(await collectLocation(account(), { creds, fetch: f, now: new Date("2026-11-16T10:00:00Z") }), { reviews: 2, rating: 4.3 });
  assert.ok(calls[0].includes("v4/accounts/1/locations/9/reviews"));
  assert.ok(calls[1].includes("v1/locations/9:fetchMultiDailyMetricsTimeSeries"));
  assert.deepEqual({ ...(db.prepare("SELECT views, calls FROM gbp_daily WHERE account_id = ? AND day = '2026-11-10'").get(acc.id) as object) }, { views: 120, calls: 3 });
  const [l] = locationsReport({ project: "boul" });
  assert.deepEqual([l.rating, l.total, l.unanswered], [4.3, 57, 1]);
  assert.equal(l.reviews.find((r) => r.review_id === "r2")!.author, "Anonyme");
});

test("avis sans réponse dans « À traiter » ; la réponse part sur Google puis disparaît de la liste", async () => {
  assert.ok(today().some((i) => i.text.includes("Boulangerie Martin · 1 avis Google sans réponse (dont une note de 2/5)")));
  let sent: any = null;
  const f = (async (u: any, i: any) => { sent = { url: String(u), method: i.method, body: JSON.parse(i.body) }; return new Response("{}"); }) as typeof fetch;
  await assert.rejects(replyReview(acc.id, "r1", " ", { creds, fetch: f }), /2 à 4 000/);
  await replyReview(acc.id, "r1", "Désolés, contactez-nous.", { creds, fetch: f });
  assert.equal(sent.method, "PUT"); assert.ok(sent.url.endsWith("/accounts/1/locations/9/reviews/r1/reply")); assert.deepEqual(sent.body, { comment: "Désolés, contactez-nous." });
  assert.equal(locationsReport({ project: "boul" })[0].unanswered, 0);
  assert.ok(!today().some((i) => i.text.includes("sans réponse") && i.text.includes("Boulangerie Martin")));
});

test("accès refusé : l'erreur est gardée et affichée, rien n'est inventé", async () => {
  const f = (async () => new Response("{}", { status: 403 })) as typeof fetch;
  assert.match(String((await collectLocation(account(), { creds, fetch: f }) as { error?: string }).error), /API Business Profile/);
  assert.match(String(locationsReport({ project: "boul" })[0].error), /refusé/);
});
