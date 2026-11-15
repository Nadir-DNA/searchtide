// D3 : statistiques TikTok, activées par TIKTOK_STATS=1 (autorisations user.info.stats et video.list).
import { test, after } from "node:test";
import assert from "node:assert/strict";

process.env.TIKTOK_STATS = "1";
const { providerFor } = await import("./provider.ts");
await import("./providers/index.ts");
const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; delete process.env.TIKTOK_STATS; });

test("TikTok activé : autorisations demandées, abonnés et chiffres des vidéos lus", async () => {
  const tk = providerFor("tiktok")!;
  assert.match(tk.authUrl("https://i.test/cb", "s", "v"), /user\.info\.stats%2Cvideo\.list/);
  assert.equal(tk.statsUnavailable, undefined);
  const bodies: any[] = [];
  globalThis.fetch = (async (u: any, i: RequestInit = {}) => {
    if (String(u).includes("/user/info/")) return Response.json({ data: { user: { follower_count: 3400, video_count: 58 } }, error: { code: "ok" } });
    bodies.push(JSON.parse(String(i.body)));
    return Response.json({ data: { videos: [{ id: "7300", view_count: 12000, like_count: 800, comment_count: 40, share_count: 25 }] } });
  }) as typeof fetch;
  assert.deepEqual(await tk.stats!("t", "open"), { followers: 3400, posts: 58 });
  const s = await tk.postStats!(["https://www.tiktok.com/@marque/video/7300"], "t", "open");
  assert.deepEqual(s, { "https://www.tiktok.com/@marque/video/7300": { views: 12000, likes: 800, comments: 40, shares: 25 } });
  assert.deepEqual(bodies[0], { filters: { video_ids: ["7300"] } });
});
