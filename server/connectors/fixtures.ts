// Fixtures de simulation des connecteurs (jamais de vrai fournisseur) : une entrée par connecteur, utilisée par le test de contrat.
// Les valeurs sont fictives ; les « clés » n'ouvrent rien.
import type { Fixture } from "./contract.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export const FIXTURES: Record<string, Fixture> = {
  stripe: {
    cfg: { config: {}, secrets: { key: "rk_" + "test_FIXTUREabcdefghij0123456789" } },
    respond: (url) => {
      if (url.includes("/balance_transactions")) return json({ data: [{ type: "charge", net: 1250 }, { type: "stripe_fee", net: -100 }, { type: "refund", net: -250 }], has_more: false });
      if (url.includes("/customers")) return json({ data: [{ id: "cus_1" }, { id: "cus_2" }], has_more: false });
      if (url.includes("/subscriptions")) return json({ data: [{ id: "sub_1", items: { data: [{ price: { unit_amount: 2900, recurring: { interval: "month" } }, quantity: 1 }] }, discounts: [] }], has_more: false });
      if (url.includes("/account")) return json({ business_profile: { name: "Boutique démo" } });
      return json({ error: { message: "inattendu" } }, 404);
    },
  },
  smtp: {
    cfg: { config: { preset: "gmail", user: "demo@exemple.com", from: "Démo <demo@exemple.com>", to: "demo@exemple.com" }, secrets: { pass: "abcdefghijklmnop" } },
  },
  ntfy: {
    cfg: { config: { server: "https://ntfy.exemple.test" }, secrets: { topic: "searchtide-0123456789abcdef", token: "tk_FIXTUREtoken0123456789" } },
    respond: () => json({ id: "msg1", event: "message" }),
  },
};
