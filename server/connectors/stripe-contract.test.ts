// CA62 : tout paramètre émis par stripeMetric doit passer la liste blanche du relais.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripeMetric } from "./stripe.ts";
import { relayAccepts } from "../../relay/src/worker.ts";
import type { Ctx } from "./types.ts";

test("CA62 : les paramètres de revenue, new_customers, active_subscriptions et mrr passent la liste blanche", async () => {
  const sent: Array<{ object: string; params: Record<string, string> }> = [];
  const ctx = { fetch: (async (_u: any, init: any) => {
    const b = JSON.parse(String(init?.body ?? "{}"));
    sent.push({ object: b.object, params: b.params ?? {} });
    return Response.json({ data: [], has_more: false });
  }) as unknown as typeof fetch, now: () => new Date(), timeoutMs: 1000 } as Ctx;
  const auth = { key: "", relay: { url: "https://connect.test", token: "relay_test" } };
  for (const metric of ["revenue", "new_customers", "active_subscriptions", "mrr"]) {
    for (const day of [undefined, "2026-11-10"]) await stripeMetric(auth, metric, day, ctx);
  }
  assert.ok(sent.length >= 4, "des appels au relais ont eu lieu");
  for (const { object, params } of sent) {
    assert.ok(relayAccepts(object, params), `${object} ${JSON.stringify(params)} doit être accepté`);
  }
});
