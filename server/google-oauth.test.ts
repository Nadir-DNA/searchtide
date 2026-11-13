// Parcours réel : instance Searchtide ↔ code du relais (lancé en local) ↔ faux Google. Aucun appel réseau externe.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { handle } from "../relay/src/worker.ts";
import { MemoryStore } from "../relay/src/store.ts";
import { login, startServer, tempDb, type Running } from "./test-server.ts";

let relay: Server, relayBase = "", srv: Running, cookie = "", tmp: ReturnType<typeof tempDb>;
const REFRESH = "1//0g-refresh-token-E2E-0123456789";
const googleCalls: string[] = [];

before(async () => {
  const store = new MemoryStore();
  relay = createServer(async (rq, rs) => {
    const url = `${relayBase}${rq.url}`;
    if (rq.url!.startsWith("/fakegoogle/")) { // faux API Google Agenda
      googleCalls.push(`${rq.method} ${rq.url} ${rq.headers.authorization}`);
      rs.setHeader("content-type", "application/json"); return rs.end(JSON.stringify({ summary: "pierre@gmail.com", timeZone: "Europe/Paris" }));
    }
    const body = ["GET", "HEAD"].includes(rq.method!) ? undefined : await new Promise<string>((ok) => { let d = ""; rq.on("data", (c) => d += c); rq.on("end", () => ok(d)); });
    const res = await handle(new Request(url, { method: rq.method, headers: rq.headers as any, body }), {
      GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "sec", STATE_SECRET: "state-secret-0123456789", RATE_SECRET: "rate-secret-0123456789",
      STRIPE_CLIENT_ID: "ca_x", STRIPE_READ_KEY: "rk_test_x", STRIPE_OAUTH_KEY: "sk_test_x", WEBHOOK_SECRET: "w", MODE: "test", RELAY_URL: relayBase, __store: store,
      __fetch: (async (u: any, i: RequestInit = {}) => String(u).startsWith("https://oauth2.googleapis.com/token") && String(i.body).includes("authorization_code")
        ? Response.json({ access_token: "ya29.a", refresh_token: REFRESH, scope: "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy" })
        : String(u).startsWith("https://oauth2.googleapis.com/token") ? Response.json({ access_token: "ya29.fresh", expires_in: 3599 }) : new Response("{}")) as typeof fetch,
    });
    rs.writeHead(res.status, Object.fromEntries(res.headers)); rs.end(Buffer.from(await res.arrayBuffer()));
  });
  await new Promise<void>((ok) => relay.listen(0, "127.0.0.1", ok));
  relayBase = `http://127.0.0.1:${(relay.address() as any).port}`;
  tmp = tempDb();
  srv = await startServer(tmp.path, { RELAY_URL: relayBase, GCAL_API_BASE: `${relayBase}/fakegoogle` });
  cookie = await login(srv.base);
});
after(() => { srv.stop(); relay.close(); tmp.done(); });
const admin = (path: string, init: RequestInit = {}) => fetch(srv.base + path, { redirect: "manual", ...init, headers: { cookie, ...(init.headers ?? {}) } });

test("connexion Google : relais joignable, consentement, jeton remis à l'instance, connexion créée sans secret exposé", async () => {
  assert.equal((await fetch(`${srv.base}/api/google-oauth/status`)).status, 401, "réservé à l'administrateur");
  const st = await (await admin("/api/google-oauth/status")).json() as any;
  assert.deepEqual([st.enabled, st.ok, st.google], [true, true, true]);

  const start = await (await admin("/api/google-oauth/start", { method: "POST" })).json() as any;
  assert.match(start.url, new RegExp(`^${relayBase}/google/authorize\\?state=`));
  const state = new URL(start.url).searchParams.get("state")!;
  assert.match(await (await fetch(start.url)).text(), /ne lit pas votre agenda/);
  const go = await fetch(`${relayBase}/google/go?state=${encodeURIComponent(state)}`, { redirect: "manual" });
  assert.match(go.headers.get("location")!, /^https:\/\/accounts\.google\.com\//);

  // Retour de Google chez le relais, puis du relais chez l'instance
  const cb = await fetch(`${relayBase}/google/callback?code=4/e2e&state=${encodeURIComponent(state)}`, { redirect: "manual" });
  const toInstance = new URL(cb.headers.get("location")!);
  assert.equal(toInstance.pathname, "/api/google-oauth/callback");
  const done = await admin(toInstance.pathname + toInstance.search);
  assert.equal(done.headers.get("location"), "/?view=rdv&gcal=ok");
  assert.ok(googleCalls.some((c) => c.includes("/events?maxResults=1") && c.endsWith("Bearer ya29.fresh")), "l'instance parle à Google avec le jeton d'accès fourni par le relais");

  const conns = await (await admin("/api/connections")).text();
  assert.match(conns, /pierre@gmail\.com/); assert.ok(!conns.includes(REFRESH), "le jeton de renouvellement n'est jamais renvoyé");
  const rdv = await (await admin("/api/rdv")).json() as any;
  assert.equal(rdv.calendar, "pierre@gmail.com"); assert.equal(rdv.meet_auto, true);

  // Un type de RDV Meet sans lien est maintenant accepté (créé automatiquement) ; un state rejoué ne recrée rien
  const t = await admin("/api/rdv/types", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug: "visio", name: "Visio", duration_min: 30, location_kind: "meet", location_value: "" }) });
  assert.equal(t.status, 201);
  const replay = await admin(toInstance.pathname + toInstance.search);
  assert.match(decodeURIComponent(replay.headers.get("location")!), /expiré/);
});

test("sans Google connecté, un type Meet sans lien est refusé", async () => {
  const t2 = tempDb(); const s2 = await startServer(t2.path);
  try {
    const c = await login(s2.base);
    const r = await fetch(`${s2.base}/api/rdv/types`, { method: "POST", headers: { cookie: c, "content-type": "application/json" }, body: JSON.stringify({ slug: "visio", name: "Visio", duration_min: 30, location_kind: "meet", location_value: "" }) });
    assert.equal(r.status, 400); assert.match((await r.json() as any).error, /Google Agenda/);
    assert.equal((await (await fetch(`${s2.base}/api/google-oauth/status`, { headers: { cookie: c } })).json() as any).enabled, false, "pas de RELAY_URL : option masquée");
  } finally { s2.stop(); t2.done(); }
});
