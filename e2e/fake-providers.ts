// Chargé AVANT le serveur des tests e2e (node --import) : remplace le réseau des connecteurs par les simulations de fixtures.ts.
// Aucune requête ne part vers Stripe, Google, un serveur SMTP, ntfy ou une base Postgres. Réservé aux tests : jamais chargé en production.
import { setConnectorContext } from "../server/connectors/api.ts";
import { setCollectContext } from "../server/connectors/use.ts";
import { realCtx } from "../server/connectors/registry.ts";
import { FIXTURES } from "../server/connectors/fixtures.ts";

const provider = (url: string) =>
  url.includes("api.stripe.com") ? "stripe" : url.includes("pagespeedonline") ? "pagespeed" : /googleapis\.com|searchconsole\./.test(url) ? "google"
  : url.includes("api.exemple.test") ? "jsonapi" : url.includes("ntfy") ? "ntfy" : null;

const ctx = realCtx({
  fetch: (async (u: any, i: RequestInit = {}) => {
    const url = String(u), f = provider(url);
    return f && FIXTURES[f]?.respond ? FIXTURES[f].respond!(url, i) : new Response("{}", { status: 404 });
  }) as typeof fetch,
  smtp: () => ({ verify: async () => true, sendMail: async () => ({}) }),
  pg: () => ({
    connect: async () => ({ query: async (sql: string) => ({ rows: FIXTURES.postgres.sql!(sql) }), release() {} }),
    end: async () => {},
  }),
});
setConnectorContext(ctx);
setCollectContext(ctx);
console.log("[e2e] fournisseurs simulés actifs");
