// D3 : statistiques des réseaux — réponses simulées des API, relevé quotidien, erreurs gardées, mesures du portefeuille.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { db } from "../db.ts";
import { savePublication } from "../business.ts";
import { createAccount } from "./queue.ts";
import { providerFor } from "./provider.ts";
import "./providers/index.ts";
import { collectAccount, socialMeasures, socialStats } from "./stats.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const route = (fn: (url: string) => unknown) => {
  const seen: string[] = [];
  globalThis.fetch = (async (u: any) => { seen.push(String(u)); const r = fn(String(u)); return r instanceof Response ? r : Response.json(r); }) as typeof fetch;
  return seen;
};
const uniq = () => `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

test("X : abonnés et posts, puis vues, j'aime, réponses et reposts par post", async () => {
  const x = providerFor("x")!;
  route((u) => u.includes("/users/42") ? { data: { public_metrics: { followers_count: 1200, tweet_count: 340 } } }
    : { data: [{ id: "111", public_metrics: { impression_count: 900, like_count: 12, reply_count: 3, retweet_count: 4, quote_count: 1 } }] });
  assert.deepEqual(await x.stats!("t", "42"), { followers: 1200, posts: 340 });
  const s = await x.postStats!(["https://x.com/i/status/111", "https://ailleurs/sans-id"], "t", "42");
  assert.deepEqual(s, { "https://x.com/i/status/111": { impressions: 900, likes: 12, comments: 3, shares: 5 } });
});

test("YouTube, Facebook, Instagram : chiffres lus, absents laissés absents", async () => {
  route((u) => u.includes("/channels") ? { items: [{ statistics: { subscriberCount: "5300", videoCount: "41", viewCount: "98000" } }] }
    : u.includes("/videos") ? { items: [{ id: "abcDEF12", statistics: { viewCount: "700", likeCount: "30" } }] }
    : u.includes("fields=followers_count%2Cfan_count") ? { followers_count: 880 }
    : u.includes("fields=followers_count%2Cmedia_count") ? { followers_count: 2100, media_count: 77 }
    : { reactions: { summary: { total_count: 25 } }, comments: { summary: { total_count: 4 } } });
  assert.deepEqual(await providerFor("youtube")!.stats!("t", "UC1"), { followers: 5300, posts: 41, views: 98000 });
  assert.deepEqual(await providerFor("youtube")!.postStats!(["https://www.youtube.com/watch?v=abcDEF12"], "t", "UC1"),
    { "https://www.youtube.com/watch?v=abcDEF12": { views: 700, likes: 30, comments: undefined } });
  assert.deepEqual(await providerFor("facebook")!.stats!("t", "page1"), { followers: 880 });
  assert.deepEqual(await providerFor("facebook")!.postStats!(["https://www.facebook.com/123_456"], "t", "page1"),
    { "https://www.facebook.com/123_456": { likes: 25, comments: 4, shares: undefined } });
  assert.deepEqual(await providerFor("instagram")!.stats!("t", "ig1"), { followers: 2100, posts: 77 });
  assert.equal(providerFor("linkedin")!.stats, undefined);
  assert.match(providerFor("linkedin")!.statsUnavailable ?? "", /LinkedIn/);
});

function setup() {
  const project = uniq();
  db.prepare("INSERT INTO projects (id, name, crm_key, created_at) VALUES (?, ?, ?, 0)").run(`id-${project}`, project, project);
  const acc = createAccount({ project, network: "x", label: "@marque" }) as any;
  db.prepare("UPDATE pub_accounts SET connection_id = 'conn-test' WHERE id = ?").run(acc.id);
  const pub = savePublication(null, { day: new Date().toISOString().slice(0, 10), title: "Annonce", project, network: "x", text: "Bonjour" }) as any;
  db.prepare("UPDATE publications SET account_id = ?, state = 'published', evidence_url = ?, published_at = ? WHERE id = ?").run(acc.id, "https://x.com/i/status/777", Date.now(), pub.id);
  return { project, account: db.prepare("SELECT * FROM pub_accounts WHERE id = ?").get(acc.id) as any, pub };
}
const creds = async () => ({ ok: true as const, token: "t", accountId: "42" });

test("relevé : abonnés du jour et chiffres des publications enregistrés ; évolution et meilleures publications", async () => {
  const { project, account, pub } = setup();
  db.prepare("INSERT INTO social_stats (account_id, day, followers) VALUES (?, ?, ?)").run(account.id, new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10), 1000);
  route((u) => u.includes("/users/42") ? { data: { public_metrics: { followers_count: 1200, tweet_count: 10 } } }
    : { data: [{ id: "777", public_metrics: { impression_count: 500, like_count: 20, reply_count: 2, retweet_count: 3, quote_count: 0 } }] });
  assert.deepEqual(await collectAccount(account, creds), { followers: 1200, posts: 1 });
  const v = socialStats({ project });
  assert.equal(v.accounts[0].followers, 1200);
  assert.equal(v.accounts[0].followersBefore, 1000, "relevé d'avant la période");
  assert.equal(v.accounts[0].error, null);
  assert.equal(v.top[0].id, pub.id);
  assert.equal(v.top[0].engagement, 25);
  const today = new Date().toISOString().slice(0, 10), old = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const m = socialMeasures({ id: `id-${project}`, crm_key: project }, { from: old, to: today }, { from: "2000-01-01", to: old }) as any;
  assert.equal(m.followers.value, 1200);
  assert.equal(m.followers.previous, 1000);
  assert.equal(m.engagement.value, 25);
});

test("erreur du réseau ou jeton expiré : message gardé sur le compte, aucun chiffre inventé", async () => {
  const { account } = setup();
  route(() => new Response("{}", { status: 403 }));
  const r = await collectAccount(account, creds) as any;
  assert.match(r.error, /X : statistiques refusées \(403\)/);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM social_stats WHERE account_id = ?").get(account.id) as any).n, 0);
  assert.match((db.prepare("SELECT stats_error FROM pub_accounts WHERE id = ?").get(account.id) as any).stats_error, /403/);
  const r2 = await collectAccount(account, async () => ({ ok: false as const, message: "Jeton expiré : reconnectez le compte" })) as any;
  assert.match(r2.error, /reconnectez/);
});

test("compte sans connexion réelle ou réseau sans statistiques : ignoré, avec la raison affichée", async () => {
  const project = uniq();
  db.prepare("INSERT INTO projects (id, name, crm_key, created_at) VALUES (?, ?, ?, 0)").run(`id-${project}`, project, project);
  const li = createAccount({ project, network: "linkedin", label: "Profil" }) as any;
  db.prepare("UPDATE pub_accounts SET connection_id = 'c' WHERE id = ?").run(li.id);
  createAccount({ project, network: "x", label: "Factice" });
  assert.deepEqual(await collectAccount(db.prepare("SELECT * FROM pub_accounts WHERE id = ?").get(li.id) as any, creds), { skipped: true });
  const v = socialStats({ project });
  assert.match(v.accounts.find((a) => a.network === "linkedin")!.unavailable ?? "", /LinkedIn/);
  assert.match(v.accounts.find((a) => a.label === "Factice")!.unavailable ?? "", /sans connexion réelle/);
});

test("Instagram : publications retrouvées par leur adresse publique, sur plusieurs pages", async () => {
  route((u) => u.includes("after=p2")
    ? { data: [{ permalink: "https://www.instagram.com/p/BBB/", like_count: 9, comments_count: 1 }] }
    : { data: [{ permalink: "https://www.instagram.com/p/AAA/", like_count: 40, comments_count: 6 }], paging: { next: "https://graph.facebook.com/next?after=p2" } });
  const s = await providerFor("instagram")!.postStats!(["https://www.instagram.com/p/AAA", "https://www.instagram.com/p/BBB/?utm=x"], "t", "ig1");
  assert.deepEqual(s, { "https://www.instagram.com/p/AAA": { likes: 40, comments: 6 }, "https://www.instagram.com/p/BBB/?utm=x": { likes: 9, comments: 1 } });
  assert.equal(providerFor("tiktok")!.stats, undefined, "TikTok sans TIKTOK_STATS : pas de relevé");
  assert.match(providerFor("tiktok")!.statsUnavailable ?? "", /TIKTOK_STATS=1/);
});
