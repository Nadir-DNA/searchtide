// Connecteur Google : un compte de service pour Search Console et, si un bucket est indiqué, Google Play (D1).
// Le fichier JSON de la clé est un secret (chiffré). L'adresse du compte de service est affichée pour être ajoutée à Search Console.
import { createSign } from "node:crypto";
import { register } from "./registry.ts";
import { ConnectorError, type Cfg, type Connector, type Ctx, type TestResult } from "./types.ts";

export type ServiceAccount = { client_email: string; private_key: string };
const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const SC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
export const GCS_SCOPE = "https://www.googleapis.com/auth/devstorage.read_only";

/** Lit le JSON d'une clé de compte de service. Message clair si c'est un autre type de fichier Google (P4). */
export function parseServiceAccount(raw: string): ServiceAccount {
  let j: any;
  try { j = JSON.parse(raw); } catch { throw new ConnectorError("format", "Ce fichier n'est pas un JSON valide."); }
  if (j?.installed || j?.web) throw new ConnectorError("format", "Ce fichier est un identifiant OAuth, pas un compte de service : créez une clé de compte de service.");
  if (j?.type !== "service_account" || !j.client_email || !j.private_key) throw new ConnectorError("format", "Ce fichier n'est pas une clé de compte de service Google : il manque client_email ou private_key.");
  return { client_email: String(j.client_email), private_key: String(j.private_key) };
}

const tokens = new Map<string, { token: string; exp: number }>();
export const clearGoogleTokens = () => tokens.clear();

/** Jeton d'accès du compte de service (JWT signé RS256, sans dépendance Google), pour une portée. Le point d'échange est fixe. */
export async function googleAccessToken(sa: ServiceAccount, scope: string, ctx: Ctx): Promise<string> {
  const k = `${sa.client_email}|${scope}`;
  const cached = tokens.get(k);
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: sa.client_email, scope, aud: TOKEN_URL, iat: now, exp: now + 3600 })}`;
  let jwt: string;
  try { jwt = `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(sa.private_key, "base64url")}`; }
  catch { throw new ConnectorError("format", "La clé privée du compte de service est illisible : recréez une clé JSON."); }
  const res = await ctx.fetch(TOKEN_URL, { method: "POST", body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }) });
  const data = await res.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
  if (!res.ok || !data.access_token) {
    if (res.status === 400 || res.status === 401) throw new ConnectorError("auth", "Google refuse cette clé : vérifiez qu'elle est complète et active (elle a peut-être été supprimée).");
    throw new ConnectorError("other", `Google ${res.status} : ${data.error_description ?? data.error ?? "erreur"}`);
  }
  tokens.set(k, { token: data.access_token, exp: Date.now() + (data.expires_in ?? 3600) * 1000 });
  return data.access_token;
}

/** Nom de bucket depuis « gs://pubsite_prod_rev_…/… » ou le nom seul. */
export const bucketName = (raw: string) => raw.trim().replace(/^gs:\/\//, "").replace(/\/.*$/, "");

// ── Google Play : rapports CSV mensuels déposés par la Play Console dans son espace Cloud Storage (UTF-16) ──
async function playCsv(bucket: string, object: string, token: string, ctx: Ctx) {
  const res = await ctx.fetch(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}?alt=media`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return [];
  if (res.status === 401 || res.status === 403) throw new ConnectorError("permission", "Google Play : accès refusé au bucket. Vérifiez l'invitation dans la Play Console (la prise en compte peut prendre du temps).");
  if (!res.ok) throw new ConnectorError("other", `Google Play ${res.status} : ${(await res.text()).slice(0, 200)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf[0] === 0xff && buf[1] === 0xfe ? buf.subarray(2).toString("utf16le") : buf.toString("utf8");
  const [head, ...lines] = text.split(/\r?\n/).filter((l) => l.trim());
  const cols = head.split(",").map((x) => x.trim());
  return lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [cols[i], v.trim()])));
}

/** Mesure Play (installs par jour, installs actifs, note) pour un package, depuis le bucket d'export de la Play Console. */
export async function playMetric(a: { sa: ServiceAccount; bucket: string; pkg: string; metric: string; day?: string; today: string }, ctx: Ctx): Promise<number> {
  const token = await googleAccessToken(a.sa, GCS_SCOPE, ctx);
  const bucket = bucketName(a.bucket);
  const month = (a.day ?? a.today).slice(0, 7).replace("-", "");
  const kind = a.metric === "rating" ? "ratings" : "installs";
  let rows = await playCsv(bucket, `stats/${kind}/${kind}_${a.pkg}_${month}_overview.csv`, token, ctx);
  if (!rows.length && !a.day) { // début de mois : rapport pas encore publié, on lit le mois précédent
    const prev = new Date(Date.UTC(+month.slice(0, 4), +month.slice(4) - 2, 1)).toISOString().slice(0, 7).replace("-", "");
    rows = await playCsv(bucket, `stats/${kind}/${kind}_${a.pkg}_${prev}_overview.csv`, token, ctx);
  }
  if (!rows.length) throw new ConnectorError("other", "Aucun rapport Google Play pour ce mois (vérifiez le nom du paquet et l'accès du compte de service)");
  const col = a.metric === "rating" ? "Total Average Rating" : a.metric === "active_installs" ? "Active Device Installs" : "Daily User Installs";
  const row = a.day ? rows.find((r) => r.Date === a.day) : rows.at(-1);
  return row ? Number(row[col]) || 0 : 0;
}

export async function searchConsoleProperties(sa: ServiceAccount, ctx: Ctx): Promise<string[]> {
  const token = await googleAccessToken(sa, SC_SCOPE, ctx);
  const res = await ctx.fetch("https://searchconsole.googleapis.com/webmasters/v3/sites", { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json().catch(() => ({})) as { siteEntry?: { siteUrl: string }[]; error?: { message?: string } };
  if (res.status === 401) throw new ConnectorError("auth", "Google refuse cette clé : vérifiez qu'elle est complète et active.");
  if (res.status === 403) throw new ConnectorError("permission", "Permission manquante : activez l'API Search Console dans votre projet Google Cloud (étape 2 du guide).");
  if (!res.ok) throw new ConnectorError("other", `Search Console ${res.status} : ${data.error?.message ?? "erreur"}`);
  return (data.siteEntry ?? []).map((s) => s.siteUrl);
}

const saOf = (c: Cfg) => parseServiceAccount(String(c.secrets.json ?? ""));

export const google: Connector = {
  id: "google", name: "Google", provider: "Google", monogram: "GO", category: "seo", minutes: 15,
  description: "Un compte de service lit vos données Search Console, et Google Play si vous indiquez le bucket de la Play Console.",
  unlocks: ["Search Console : clics, impressions, CTR, position, opportunités", "Play (si le bucket est renseigné) : installs par jour, installs actifs, note"],
  fields: [
    { key: "json", label: "Clé du compte de service (fichier JSON)", type: "json", secret: true, required: true, help: "Collez le contenu du fichier ou choisissez-le. Il est chiffré et n'est plus jamais affiché." },
    { key: "playBucket", label: "Bucket Google Play (facultatif)", type: "text", placeholder: "gs://pubsite_prod_rev_…", help: "Console Play → Télécharger les rapports → Copier l'URI Cloud Storage." },
  ],
  guide: [
    { text: "Créez un projet Google Cloud.", url: "https://console.cloud.google.com/projectcreate" },
    { text: "Activez l'API Search Console.", url: "https://console.cloud.google.com/apis/library/searchconsole.googleapis.com" },
    { text: "Créez un compte de service, puis une clé JSON.", url: "https://console.cloud.google.com/iam-admin/serviceaccounts" },
    { text: "Déposez le fichier JSON ici." },
    { text: "Ajoutez l'adresse du compte de service (affichée après l'enregistrement) comme utilisateur « Restreint » de chaque propriété Search Console.", url: "https://search.google.com/search-console/users" },
    { text: "Play, facultatif : invitez la même adresse dans la Play Console (Utilisateurs et autorisations, vue des infos de l'app en « Global »), puis copiez l'URI gs://pubsite_prod_rev_… des rapports." },
  ],
  revokeUrl: "https://console.cloud.google.com/iam-admin/serviceaccounts",
  readPosts: ["POST https://oauth2.googleapis.com/token", "POST https://searchconsole.googleapis.com/webmasters/v3/sites/"],
  hint(c) { try { return saOf(c).client_email; } catch { return "compte de service"; } },
  async test(c, ctx): Promise<TestResult> {
    const sa = saOf(c);
    const bucketRaw = String(c.config.playBucket ?? "").trim();
    if (bucketRaw && !/^[a-z0-9][a-z0-9._-]{2,221}$/.test(bucketName(bucketRaw))) throw new ConnectorError("format", "Le bucket Google Play ressemble à gs://pubsite_prod_rev_… : copiez l'URI depuis la Play Console.");
    const props = await searchConsoleProperties(sa, ctx);
    const warnings: string[] = [];
    if (!props.length) warnings.push(`Aucune propriété visible : ajoutez ${sa.client_email} dans Search Console.`);
    let play = "";
    if (bucketRaw) {
      const token = await googleAccessToken(sa, GCS_SCOPE, ctx);
      const res = await ctx.fetch(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucketName(bucketRaw))}/o?maxResults=1`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) play = ", bucket Play accessible";
      else warnings.push("Play : accès refusé au bucket. Vérifiez l'invitation dans la Play Console (la prise en compte peut prendre du temps).");
    }
    return { ok: true, label: sa.client_email, account: sa.client_email, warnings, detail: `${props.length} propriété${props.length > 1 ? "s" : ""} Search Console${play}` };
  },
  kpis: [
    { id: "daily_installs", label: "Installations par jour (Play)", mode: "daily", backfill: true, params: [{ key: "package", label: "Nom du package", type: "text", required: true, placeholder: "com.exemple.app" }] },
    { id: "active_installs", label: "Installations actives (Play)", mode: "total", params: [{ key: "package", label: "Nom du package", type: "text", required: true, placeholder: "com.exemple.app" }] },
    { id: "rating", label: "Note moyenne (Play)", mode: "total", params: [{ key: "package", label: "Nom du package", type: "text", required: true, placeholder: "com.exemple.app" }] },
  ],
  async collect(c, kpi, params, day, ctx) {
    const bucket = String(c.config.playBucket ?? "");
    if (!bucket) throw new ConnectorError("format", "Aucun bucket Google Play n'est renseigné pour cette connexion : modifiez-la pour l'ajouter.");
    const pkg = String(params.package ?? "");
    if (!/^[a-z][a-z0-9_.]+$/.test(pkg)) throw new ConnectorError("format", "Nom de package invalide (exemple : com.exemple.app).");
    return playMetric({ sa: saOf(c), bucket, pkg, metric: kpi.id, day: kpi.mode === "daily" ? day : undefined, today: ctx.now().toISOString().slice(0, 10) }, ctx);
  },
};
register(google);
