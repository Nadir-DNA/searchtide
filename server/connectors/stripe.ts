// Connecteur Stripe : clé restreinte `rk_` en lecture seule (D3, R8). La clé appartient au compte : aucun en-tête Stripe-Account.
// Les clés `sk_` (complètes, y compris d'organisation) sont refusées dans l'interface. Les indicateurs qui désignent une variable
// d'environnement (config.env, ancien mode, CA20) gardent leur comportement, y compris la clé d'organisation sk_org_.
import { register } from "./registry.ts";
import { ConnectorError, type Cfg, type Connector, type Ctx, type TestResult } from "./types.ts";

type Row = Record<string, any>;
const API = "https://api.stripe.com/v1";

/** Minuit à Paris pour un jour AAAA-MM-JJ, en secondes Unix (gère l'heure d'été). */
export function parisMidnight(d: string) {
  const utc = Date.parse(d + "T00:00:00Z");
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: process.env.DAY_TZ ?? "Europe/Paris", hour: "numeric", hourCycle: "h23" }).formatToParts(utc).map((x) => [x.type, x.value]));
  return utc / 1000 - Number(p.hour) * 3600;
}

/** Revenu mensuel d'un abonnement, remises déduites (un coupon à 100 % compte pour 0), en centimes. */
export function monthlyNet(s: Row) {
  const perMonth: Record<string, number> = { day: 30, week: 52 / 12, month: 1, year: 1 / 12 };
  const it0 = s.items.data[0]?.price?.recurring;
  const toMonth = (perMonth[it0?.interval] ?? 1) / (it0?.interval_count ?? 1);
  const gross = s.items.data.reduce((m: number, it: Row) => m + (it.price?.unit_amount ?? 0) * (it.quantity ?? 1), 0);
  let net = gross;
  for (const d of (s.discounts ?? []) as Row[]) {
    if (typeof d !== "object" || !d.coupon) continue;
    if (d.coupon.percent_off) net *= 1 - d.coupon.percent_off / 100;
    if (d.coupon.amount_off) net -= d.coupon.amount_off;
  }
  return Math.max(net, 0) * toMonth;
}

const REFUSED = (provider = "Stripe") => `${provider} refuse cette clé : vérifiez qu'elle est complète et active.`;

/** Liste paginée. Clé d'organisation (ancien mode) : le compte visé passe dans Stripe-Context ; clé de plateforme : Stripe-Account ; clé restreinte : aucun des deux. */
export async function stripeList(key: string, path: string, params: Record<string, string>, account: string | undefined, ctx: Ctx): Promise<Row[]> {
  const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
  if (key.startsWith("sk_org_")) {
    if (!account) throw new Error("Clé d'organisation Stripe : indiquez le compte (acct_…) de l'entreprise");
    Object.assign(headers, { "Stripe-Context": account, "Stripe-Version": "2025-03-31.basil" });
  } else if (account) headers["Stripe-Account"] = account;
  const items: Row[] = [];
  let after: string | undefined;
  do {
    const q = new URLSearchParams({ ...params, limit: "100", ...(after && { starting_after: after }) });
    const res = await ctx.fetch(`${API}/${path}?${q}`, { headers });
    const j = await res.json().catch(() => ({})) as Row;
    if (res.status === 401) throw new ConnectorError("auth", REFUSED());
    if (res.status === 403) throw new ConnectorError("permission", `Permission manquante : ${RESOURCE[path] ?? path} en lecture.`);
    if (!res.ok) throw new ConnectorError("other", `Stripe ${res.status} : ${j.error?.message ?? "erreur"}`);
    items.push(...j.data);
    after = j.has_more ? j.data.at(-1)?.id : undefined;
  } while (after && items.length < 10_000);
  return items;
}
// Libellés des ressources dans les messages d'erreur (à confirmer dans le Dashboard, question Q1)
const RESOURCE: Record<string, string> = { balance_transactions: "Balance", customers: "Customers", subscriptions: "Subscriptions" };

/** Une seule requête de lecture (limit=1) : vérifie la clé et la permission sur une ressource, sans parcourir les données. */
async function probe(key: string, path: string, ctx: Ctx) {
  const res = await ctx.fetch(`${API}/${path}?limit=1`, { headers: { Authorization: `Bearer ${key}` } });
  if (res.status === 401) throw new ConnectorError("auth", REFUSED());
  if (res.status === 403) throw new ConnectorError("permission", `Permission manquante : ${RESOURCE[path] ?? path} en lecture.`);
  if (!res.ok) throw new ConnectorError("other", `Stripe ${res.status} : ${((await res.json().catch(() => ({}))) as Row).error?.message ?? "erreur"}`);
}

export type StripeAuth = { key: string; account?: string; relay?: { url: string; token: string } };

/** Lecture via le relais Searchtide Connect : aucune clé Stripe dans l'instance. */
async function relayRead(relay: { url: string; token: string }, object: string, params: Record<string, string>, ctx: Ctx): Promise<Row> {
  const res = await ctx.fetch(`${relay.url.replace(/\/$/, "")}/v1/stripe/read`, {
    method: "POST", headers: { authorization: `Bearer ${relay.token}`, "content-type": "application/json" }, body: JSON.stringify({ object, params }),
  });
  if (res.status === 401) throw new ConnectorError("auth", "Stripe indique que l'accès a été retiré : reconnectez le compte.");
  if (res.status === 429) throw new ConnectorError("other", "Trop de demandes : réessayez dans quelques minutes.");
  if (!res.ok) throw new ConnectorError("other", `Relais Searchtide ${res.status} : réessayez, ou utilisez une clé limitée.`);
  return await res.json() as Row;
}
async function listRows(a: StripeAuth, object: string, params: Record<string, string>, ctx: Ctx): Promise<Row[]> {
  if (a.relay) { const j = await relayRead(a.relay, object, params, ctx); return (j.data ?? []) as Row[]; }
  return stripeList(a.key, object, params, a.account, ctx);
}
/** Valeur d'un KPI Stripe. `day` : jour civil (indicateurs journaliers) ; sinon niveau actuel. */
export async function stripeMetric(a: StripeAuth, metric: string, day: string | undefined, ctx: Ctx): Promise<number> {
  const start = day ? parisMidnight(day) : 0;
  const range: Record<string, string> = day ? { "created[gte]": String(start), "created[lt]": String(start + 86400) } : {};
  if (metric === "revenue") {
    // Net encaissé : ventes moins frais Stripe et remboursements (mouvements du solde, dans la devise du compte)
    const txs = await listRows(a, "balance_transactions", range, ctx);
    return txs.filter((x) => ["charge", "payment", "refund", "payment_refund", "adjustment", "payment_failure_refund"].includes(x.type)).reduce((n, x) => n + x.net, 0) / 100;
  }
  if (metric === "new_customers") return (await listRows(a, "customers", range, ctx)).length;
  const subs = await listRows(a, "subscriptions", { status: "active", ...(a.relay ? {} : { "expand[]": "data.discounts" }) }, ctx);
  if (metric === "active_subscriptions") return subs.length;
  if (metric === "mrr") return subs.reduce((n, s) => n + monthlyNet(s), 0) / 100;
  throw new Error(`Mesure Stripe inconnue : ${metric}`);
}

/** Symbole d'une devise (code ISO en minuscules) ; le code en majuscules à défaut. */
export const currencyUnit = (code?: string) => ({ eur: "€", usd: "$", gbp: "£", chf: "CHF", cad: "CA$", aud: "A$", jpy: "¥" } as Record<string, string>)[String(code ?? "").toLowerCase()] ?? (code ? String(code).toUpperCase() : "€");

const keyOf = (c: Cfg) => String(c.secrets.key ?? c.secrets.access_token ?? "");

/** Contrôle le format de la clé collée avant tout appel réseau (R8). */
function checkKey(key: string) {
  if (key.startsWith("sk_")) throw new ConnectorError("format", "Clé complète refusée : créez une clé limitée en lecture.");
  if (!/^rk_(live|test)_[A-Za-z0-9]{8,}$/.test(key)) throw new ConnectorError("format", "Une clé limitée commence par rk_.");
}

export const stripe: Connector = {
  id: "stripe", name: "Stripe", provider: "Stripe", monogram: "ST", category: "revenus", minutes: 3,
  description: "Lecture seule. Aucun mouvement d'argent n'est possible.",
  unlocks: ["CA net", "MRR", "Abonnements actifs", "Nouveaux clients"],
  fields: [{ key: "key", label: "Clé limitée", type: "text", secret: true, required: true, placeholder: "rk_live_…", help: "Une clé qui commence par rk_. Les clés complètes (sk_) sont refusées." }],
  guide: [
    { text: "Ouvrez la page des clés Stripe, puis « Créer une clé limitée ».", url: "https://dashboard.stripe.com/apikeys" },
    { text: "Dans la liste des autorisations, passez « Customers », « Subscriptions » et « Balance » en « Lecture », ainsi que « Balance Transaction Sources » pour les transactions ; laissez le reste sur « Aucune » (les noms restent en anglais dans le Dashboard)." },
    { text: "Copiez la clé rk_… : elle n'est montrée qu'une fois." },
  ],
  revokeUrl: "https://dashboard.stripe.com/apikeys",
  hint(c) { if (c.config.relay) return String(c.config.hint ?? "relay_…"); const k = keyOf(c); const m = /^(rk_(?:live|test)_)/.exec(k); return m ? `${m[1]}…${k.slice(-4)}` : `…${k.slice(-4)}`; },
  async test(c, ctx): Promise<TestResult> {
    if (c.config.relay) {
      const relay = { url: String(c.config.relay_url ?? ""), token: String(c.secrets.token ?? "") };
      if (!relay.url || !relay.token) throw new ConnectorError("format", "Connexion au relais incomplète : recommencez la connexion.");
      const b = await relayRead(relay, "balance", {}, ctx).catch((e) => { throw e; });
      const cur = String((b.available as Row[] | undefined)?.[0]?.currency ?? "").toLowerCase();
      return { ok: true, label: String(c.config.account_name ?? "Compte Stripe"), livemode: !!c.config.livemode, settings: cur ? { currency: cur } : undefined,
        detail: `${c.config.account_name ?? "Compte Stripe"}, mode ${c.config.livemode ? "production" : "test"}${cur ? `, devise ${cur.toUpperCase()}` : ""} (via Searchtide Connect)` };
    }
    const key = keyOf(c);
    checkKey(key);
    const live = key.startsWith("rk_live_");
    // Les trois lectures dont dépendent les KPI : une permission manquante est signalée avant l'enregistrement
    for (const path of ["balance_transactions", "customers", "subscriptions"]) await probe(key, path, ctx);
    let name = "", currency = "";
    try { // devise du compte : sert d'unité aux indicateurs d'argent (facultatif)
      const b = await ctx.fetch(`${API}/balance`, { headers: { Authorization: `Bearer ${key}` } });
      if (b.ok) currency = String(((await b.json()) as Row).available?.[0]?.currency ?? "").toLowerCase();
    } catch { /* la devise est facultative */ }
    try {
      const res = await ctx.fetch(`${API}/account`, { headers: { Authorization: `Bearer ${key}` } });
      if (res.ok) { const a = await res.json() as Row; name = String(a.business_profile?.name ?? a.settings?.dashboard?.display_name ?? "").slice(0, 80); currency ||= String(a.default_currency ?? "").toLowerCase(); }
    } catch { /* le nom est facultatif */ }
    return { ok: true, label: name || "Compte Stripe", livemode: live, settings: currency ? { currency } : undefined,
      detail: `${name || "Compte Stripe"}, mode ${live ? "production" : "test"}${currency ? `, devise ${currency.toUpperCase()}` : ""}` };
  },
  kpis: [
    { id: "revenue", label: "CA net", mode: "daily", backfill: true, money: true },
    { id: "new_customers", label: "Nouveaux clients", mode: "daily", backfill: true },
    { id: "active_subscriptions", label: "Abonnements actifs", mode: "total" },
    { id: "mrr", label: "MRR", mode: "total", money: true },
  ],
  presets: [
    { kpi: "revenue", label: "CA net" }, { kpi: "mrr", label: "MRR" },
    { kpi: "active_subscriptions", label: "Abonnements actifs" }, { kpi: "new_customers", label: "Nouveaux clients" },
  ],
  toIndicator: (kpi) => ({ source: "stripe", config: { metric: kpi.id } }),
  async collect(c, kpi, _p, day, ctx) {
    const auth: StripeAuth = c.config.relay
      ? { key: "", relay: { url: String(c.config.relay_url ?? ""), token: String(c.secrets.token ?? "") } }
      : { key: keyOf(c) };
    return stripeMetric(auth, kpi.id, kpi.mode === "daily" ? day : undefined, ctx);
  },
};
register(stripe);
