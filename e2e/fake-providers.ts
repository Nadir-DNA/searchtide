// Chargé AVANT le serveur des tests e2e (node --import) : remplace le réseau des connecteurs par les simulations de fixtures.ts.
// Aucune requête ne part vers Stripe, Google, un serveur SMTP, ntfy ou une base Postgres. Réservé aux tests : jamais chargé en production.
import { setConnectorContext } from "../server/connectors/api.ts";
import { setCollectContext } from "../server/connectors/use.ts";
import { simCtx } from "../server/connectors/sim.ts";

const ctx = simCtx({ now: () => new Date() });
setConnectorContext(ctx);
setCollectContext(ctx);
console.log("[e2e] fournisseurs simulés actifs");
