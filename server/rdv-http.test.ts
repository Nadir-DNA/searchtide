import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { login, startServer, tempDb, type Running } from "./test-server.ts";

let srv: Running, cookie = "", tmp: ReturnType<typeof tempDb>;
before(async () => { tmp = tempDb(); srv = await startServer(tmp.path); cookie = await login(srv.base); });
after(() => { srv.stop(); tmp.done(); });
const admin = (path: string, method = "GET", json?: unknown) => fetch(srv.base + path, { method, headers: { cookie, ...(json ? { "content-type": "application/json" } : {}) }, body: json ? JSON.stringify(json) : undefined });
const everyDay = Object.fromEntries(["0", "1", "2", "3", "4", "5", "6"].map((d) => [d, [["00:00", "23:30"]]]));

test("module inactif : la page publique est introuvable, l'API admin exige la session", async () => {
  assert.equal((await fetch(`${srv.base}/rdv/test`)).status, 404);
  assert.equal((await fetch(`${srv.base}/api/rdv`)).status, 401);
});

test("parcours complet : type, page, créneaux, réservation, flux iCal, annulation", async () => {
  assert.equal((await admin("/api/modules/rdv", "POST", { enabled: true })).status, 200);
  const bad = await admin("/api/rdv/types", "POST", { slug: "x", name: "Test", duration_min: 30, location_kind: "meet", location_value: "pas-un-lien" });
  assert.equal(bad.status, 400);
  const made = await admin("/api/rdv/types", "POST", { slug: "appel", name: "Appel <b>", duration_min: 30, location_kind: "meet", location_value: "https://meet.google.com/abc-defg", rules: everyDay, min_notice_h: 0 });
  assert.equal(made.status, 201);

  const page = await (await fetch(`${srv.base}/rdv/appel`)).text();
  assert.match(page, /Appel &lt;b&gt;/); assert.ok(!page.includes("Appel <b>"), "le nom est échappé");

  const now = Date.now();
  const { slots } = await (await fetch(`${srv.base}/rdv/appel/slots?from=${now}&to=${now + 3 * 864e5}`)).json() as { slots: number[] };
  assert.ok(slots.length > 10);
  assert.equal((await fetch(`${srv.base}/rdv/appel/slots?from=0&to=${400 * 864e5}`)).status, 400, "période trop large refusée");

  const post = (b: unknown) => fetch(`${srv.base}/rdv/appel/book`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  assert.equal((await post({ start: slots[0], name: "Léa", email: "pas-un-email" })).status, 400);
  assert.equal((await post({ start: slots[0], name: "Robot", email: "r@exemple.fr", website: "http://spam" })).status, 200);
  const ok = await post({ start: slots[0], name: "Léa", email: "lea@exemple.fr", message: "Bonjour" });
  assert.equal(ok.status, 201);
  const { manage } = await ok.json() as { manage: string };
  assert.equal((await post({ start: slots[0], name: "Autre", email: "b@exemple.fr" })).status, 409, "créneau déjà pris");

  const list = await (await admin("/api/rdv/bookings?when=upcoming")).json() as any[];
  assert.equal(list.length, 1, "le piège anti-robot n'enregistre rien"); assert.equal(list[0].token, undefined, "jamais de jeton dans l'API admin");

  const feedUrl = (await (await admin("/api/rdv")).json() as any).feed_url as string;
  const feed = await fetch(srv.base + new URL(feedUrl, srv.base).pathname);
  assert.match(feed.headers.get("content-type") ?? "", /text\/calendar/); assert.match(await feed.text(), /SUMMARY:Appel <b> — Léa/);
  assert.equal((await fetch(`${srv.base}/rdv/feed/mauvais.ics`)).status, 404);

  assert.equal((await fetch(srv.base + manage)).status, 200);
  assert.equal((await fetch(`${srv.base}/rdv/c/inconnu`)).status, 404);
  assert.equal((await fetch(srv.base + manage + "/cancel", { method: "POST" })).status, 200);
  assert.equal((await fetch(srv.base + manage + "/cancel", { method: "POST" })).status, 409);
  const again = await (await fetch(`${srv.base}/rdv/appel/slots?from=${now}&to=${now + 3 * 864e5}`)).json() as { slots: number[] };
  assert.ok(again.slots.includes(slots[0]), "le créneau est libéré");
});
