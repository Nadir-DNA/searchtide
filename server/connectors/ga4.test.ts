// A7 : Google Analytics 4 — requête runReport par jour, filtre « recherche Google », messages d'accès refusé.
import { test } from "node:test";
import assert from "node:assert/strict";
import { realCtx } from "./registry.ts";
import { clearGoogleTokens } from "./google.ts";
import { ga4 } from "./ga4.ts";
import { FIXTURES } from "./fixtures.ts";

const cfg = FIXTURES.ga4.cfg;
function ctx(handler: (url: string, body: any) => Response) {
  const calls: { url: string; body: any }[] = [];
  return { calls, ctx: realCtx({ now: () => new Date("2026-11-16T10:00:00Z"), fetch: (async (u: any, i: any = {}) => {
    const url = String(u);
    if (url.startsWith("https://oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "T", expires_in: 3600 }));
    const body = i.body ? JSON.parse(String(i.body)) : null; calls.push({ url, body });
    return handler(url, body);
  }) as typeof fetch }) };
}

test("GA4 : une mesure par jour ; sessions venues de Google filtrées sur « Organic Search »", async () => {
  clearGoogleTokens();
  const { calls, ctx: c } = ctx(() => new Response(JSON.stringify({ rows: [{ metricValues: [{ value: "42" }] }] })));
  assert.equal(await ga4.collect!(cfg, ga4.kpis!.find((k) => k.id === "organic_sessions")!, {}, "2026-11-15", c), 42);
  assert.deepEqual(calls[0].body.dateRanges, [{ startDate: "2026-11-15", endDate: "2026-11-15" }]);
  assert.equal(calls[0].body.metrics[0].name, "sessions");
  assert.equal(calls[0].body.dimensionFilter.filter.stringFilter.value, "Organic Search");
  assert.equal(await ga4.collect!(cfg, ga4.kpis!.find((k) => k.id === "key_events")!, {}, "2026-11-15", c), 42);
  assert.equal(calls[1].body.metrics[0].name, "keyEvents"); assert.equal(calls[1].body.dimensionFilter, undefined);
  const empty = ctx(() => new Response(JSON.stringify({})));
  assert.equal(await ga4.collect!(cfg, ga4.kpis![0], {}, "2026-11-15", empty.ctx), 0, "aucune ligne = 0 session ce jour-là");
});

test("GA4 : accès refusé expliqué ; identifiant de mesure G-… refusé", async () => {
  clearGoogleTokens();
  const denied = ctx(() => new Response(JSON.stringify({ error: { message: "User does not have sufficient permissions" } }), { status: 403 }));
  await assert.rejects(ga4.test(cfg, denied.ctx), /comme « Lecteur »/);
  const api = ctx(() => new Response(JSON.stringify({ error: { message: "Google Analytics Data API has not been used in project 1" } }), { status: 403 }));
  await assert.rejects(ga4.test(cfg, api.ctx), /Activez « Google Analytics Data API »/);
  await assert.rejects(ga4.test({ ...cfg, config: { property_id: "G-ABC123" } }, api.ctx), /pas l'ID de mesure/);
});
