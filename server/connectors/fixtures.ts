// Fixtures de simulation des connecteurs (jamais de vrai fournisseur) : une entrée par connecteur, utilisée par le test de contrat.
// Les valeurs sont fictives ; les « clés » n'ouvrent rien.
import { generateKeyPairSync } from "node:crypto";
import type { Fixture } from "./contract.ts";

// Compte de service FICTIF : la clé RSA est générée à l'import, jetable, et n'ouvre rien.
export const GOOGLE_EMAIL = "searchtide-demo@projet-demo.iam.gserviceaccount.com";
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
export const GOOGLE_JSON = JSON.stringify({ type: "service_account", project_id: "projet-demo", private_key_id: "0123456789abcdef0123456789abcdef01234567", private_key: rsa, client_email: GOOGLE_EMAIL, client_id: "123456789012345678901" });
const utf16 = (text: string) => new Response(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]));

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
  google: {
    cfg: { config: { playBucket: "gs://pubsite_prod_rev_01234567890123456789" }, secrets: { json: GOOGLE_JSON } },
    params: { daily_installs: { package: "com.exemple.app" }, active_installs: { package: "com.exemple.app" }, rating: { package: "com.exemple.app" } },
    respond: (url) => {
      if (url.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "ya29.FIXTUREaccessTOKENdemo", expires_in: 3600 });
      if (url.includes("searchconsole.googleapis.com/webmasters/v3/sites")) return json({ siteEntry: [{ siteUrl: "sc-domain:exemple.com" }, { siteUrl: "https://www.exemple.com/" }] });
      if (url.includes("stats%2Finstalls%2F")) return utf16("Date,Package Name,Daily User Installs,Active Device Installs\n2026-11-08,com.exemple.app,12,300\n2026-11-09,com.exemple.app,15,310\n");
      if (url.includes("stats%2Fratings%2F")) return utf16("Date,Package Name,Daily Average Rating,Total Average Rating\n2026-11-09,com.exemple.app,4.5,4.4\n");
      if (url.includes("storage.googleapis.com/storage/v1/b/")) return json({ items: [] });
      return json({ error: { message: "inattendu" } }, 404);
    },
  },
};
