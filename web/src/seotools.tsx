// Outils SEO d'un site (plan A2 et A3) : vérificateur de page, générateur de robots.txt, générateur de données structurées.
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { api, type Site } from "./api";
import { Button, Card, copyText, fmt, inputCls } from "./ui";

type Check = { id: string; label: string; status: "ok" | "warn" | "bad" | "info"; value: string; advice?: string };
type Result = { url: string; score: { ok: number; warn: number; bad: number }; checks: Check[] };

const STATUS = {
  bad: { text: "À corriger", led: "led-bad", cls: "text-negative" },
  warn: { text: "À améliorer", led: "led-warn", cls: "text-warn" },
  ok: { text: "Bon", led: "led-ok", cls: "text-positive" },
  info: { text: "Info", led: "led-off", cls: "text-muted" },
} as const;
const ORDER = { bad: 0, warn: 1, info: 2, ok: 3 } as const;

function CopyBlock({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"" | "ok" | "err">("");
  return (
    <div className="mt-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="label-caps">{label}</span>
        <span className="flex items-center gap-3">
          {state && <span role="status" className={`text-xs ${state === "ok" ? "text-positive" : "text-negative"}`}>{state === "ok" ? "Copié" : "Copie impossible : sélectionnez le texte"}</span>}
          <Button type="button" variant="secondary" onClick={async () => setState((await copyText(text)) ? "ok" : "err")}>Copier</Button>
        </span>
      </div>
      <pre className="max-h-80 overflow-auto rounded-xl border border-border bg-raised p-4 font-mono text-xs leading-5 whitespace-pre-wrap">{text}</pre>
    </div>
  );
}

const Field = ({ label, children }: { label: string; children: ReactNode }) => <label className="block text-sm"><span className="mb-1.5 block text-muted">{label}</span>{children}</label>;

export function PageChecker({ site }: { site: Site }) {
  const [path, setPath] = useState("/");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  async function run(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(""); setResult(null);
    try { setResult(await api<Result>(`/api/sites/${site.id}/page-check?url=${encodeURIComponent(path)}`)); }
    catch (err) { setError((err as Error).message); }
    setBusy(false);
  }
  const checks = useMemo(() => [...(result?.checks ?? [])].sort((a, b) => ORDER[a.status] - ORDER[b.status]), [result]);
  return (
    <Card title="Vérifier une page">
      <form onSubmit={run} className="flex flex-wrap items-end gap-3">
        <label className="min-w-0 flex-[1_1_280px] text-sm"><span className="mb-1.5 block text-muted">Adresse sur {site.domain}</span>
          <span className="flex items-center rounded-lg border border-control bg-raised pl-3 text-sm"><span className="shrink-0 text-muted">https://{site.domain}</span>
            <input value={path} onChange={(e) => setPath(e.target.value)} aria-label="Chemin de la page" className="h-10 min-w-0 flex-1 bg-transparent px-1 text-ink outline-none" placeholder="/tarifs" /></span>
        </label>
        <Button disabled={busy}>{busy ? "Vérification…" : "Vérifier"}</Button>
      </form>
      <p className="mt-2 text-xs text-muted">La page, son robots.txt et le sitemap sont lus depuis votre instance, comme le ferait un robot. Seules les adresses de ce site sont acceptées.</p>
      {error && <p role="alert" className="mt-4 text-sm text-negative">{error}</p>}
      {result && (
        <div className="mt-5">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2" aria-live="polite">
            <span className="text-sm text-muted">{result.url}</span>
            <span className="num text-sm"><span className="text-negative">{result.score.bad} à corriger</span> · <span className="text-warn">{result.score.warn} à améliorer</span> · <span className="text-positive">{result.score.ok} bons</span></span>
          </div>
          <ul className="mt-3 divide-y divide-rule">
            {checks.map((c) => (
              <li key={c.id} className="grid gap-x-4 gap-y-1 py-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
                <div className="flex items-start gap-2.5"><span aria-hidden className={`led mt-1.5 ${STATUS[c.status].led}`} />
                  <div><div className="font-medium">{c.label}</div><div className={`text-xs font-semibold ${STATUS[c.status].cls}`}>{STATUS[c.status].text}</div></div></div>
                <div className="min-w-0 text-sm"><div className="break-words">{c.value}</div>{c.advice && <div className="mt-0.5 text-muted">{c.advice}</div>}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

const AI_BOTS = ["GPTBot", "ClaudeBot", "CCBot", "Google-Extended"];

export function RobotsGenerator({ domain }: { domain: string }) {
  const [sitemap, setSitemap] = useState(`https://${domain}/sitemap.xml`);
  const [blocked, setBlocked] = useState("/admin/\n/panier/");
  const [noAi, setNoAi] = useState(false);
  const text = [
    "User-agent: *",
    ...blocked.split("\n").map((l) => l.trim()).filter(Boolean).map((p) => `Disallow: ${p.startsWith("/") ? p : "/" + p}`),
    ...(blocked.trim() ? [] : ["Disallow:"]),
    ...(noAi ? AI_BOTS.flatMap((b) => ["", `User-agent: ${b}`, "Disallow: /"]) : []),
    ...(sitemap.trim() ? ["", `Sitemap: ${sitemap.trim()}`] : []),
  ].join("\n");
  return (
    <Card title="Générer un robots.txt">
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Adresse du sitemap"><input value={sitemap} onChange={(e) => setSitemap(e.target.value)} className={inputCls} /></Field>
        <Field label="Chemins à ne pas explorer (un par ligne)"><textarea value={blocked} onChange={(e) => setBlocked(e.target.value)} rows={3} className={`${inputCls} h-auto py-2`} /></Field>
      </div>
      <label className="mt-4 flex items-start gap-2.5 text-sm"><input type="checkbox" checked={noAi} onChange={(e) => setNoAi(e.target.checked)} className="mt-0.5 size-4 accent-[var(--color-accent)]" />
        <span>Bloquer les robots d'entraînement des IA ({AI_BOTS.join(", ")})<span className="block text-xs text-muted">Votre contenu ne servira plus à les entraîner, mais vous pouvez aussi perdre en présence dans leurs réponses.</span></span></label>
      <CopyBlock text={text} label={`À publier sur https://${domain}/robots.txt`} />
    </Card>
  );
}

type SchemaType = "Organization" | "LocalBusiness" | "Product" | "Article" | "FAQPage";
const SCHEMA_FIELDS: Record<SchemaType, [string, string][]> = {
  Organization: [["name", "Nom"], ["url", "Site"], ["logo", "Adresse du logo"], ["sameAs", "Profils (un par ligne)"]],
  LocalBusiness: [["name", "Nom"], ["url", "Site"], ["telephone", "Téléphone"], ["streetAddress", "Adresse"], ["postalCode", "Code postal"], ["addressLocality", "Ville"], ["openingHours", "Horaires (ex. Mo-Fr 09:00-18:00)"]],
  Product: [["name", "Nom"], ["description", "Description"], ["image", "Adresse de l'image"], ["brand", "Marque"], ["price", "Prix"]],
  Article: [["headline", "Titre"], ["author", "Auteur"], ["datePublished", "Date de publication (AAAA-MM-JJ)"], ["image", "Adresse de l'image"]],
  FAQPage: [["faq", "Questions et réponses : une par ligne, « Question ? | Réponse »"]],
};
const LABELS: Record<SchemaType, string> = { Organization: "Organisation", LocalBusiness: "Entreprise locale", Product: "Produit", Article: "Article", FAQPage: "FAQ" };

export function buildSchema(type: SchemaType, v: Record<string, string>, domain: string): object {
  const s = (k: string) => (v[k] ?? "").trim() || undefined;
  const base = { "@context": "https://schema.org", "@type": type };
  if (type === "Organization") return { ...base, name: s("name"), url: s("url") ?? `https://${domain}`, logo: s("logo"), sameAs: s("sameAs")?.split("\n").map((x) => x.trim()).filter(Boolean) };
  if (type === "LocalBusiness") return { ...base, name: s("name"), url: s("url") ?? `https://${domain}`, telephone: s("telephone"), openingHours: s("openingHours"),
    address: { "@type": "PostalAddress", streetAddress: s("streetAddress"), postalCode: s("postalCode"), addressLocality: s("addressLocality"), addressCountry: "FR" } };
  if (type === "Product") return { ...base, name: s("name"), description: s("description"), image: s("image"), brand: s("brand") ? { "@type": "Brand", name: s("brand") } : undefined,
    offers: s("price") ? { "@type": "Offer", price: s("price")!.replace(",", "."), priceCurrency: "EUR", availability: "https://schema.org/InStock" } : undefined };
  if (type === "Article") return { ...base, headline: s("headline"), author: s("author") ? { "@type": "Person", name: s("author") } : undefined, datePublished: s("datePublished"), image: s("image") };
  return { ...base, mainEntity: (v.faq ?? "").split("\n").map((l) => l.split("|")).filter((p) => p.length >= 2 && p[0].trim())
    .map(([q, ...a]) => ({ "@type": "Question", name: q.trim(), acceptedAnswer: { "@type": "Answer", text: a.join("|").trim() } })) };
}

export function SchemaGenerator({ domain }: { domain: string }) {
  const [type, setType] = useState<SchemaType>("Organization");
  const [values, setValues] = useState<Record<string, string>>({});
  const json = JSON.stringify(buildSchema(type, values, domain), null, 2);
  return (
    <Card title="Générer des données structurées">
      <Field label="Type de page">
        <select value={type} onChange={(e) => setType(e.target.value as SchemaType)} className={inputCls}>
          {(Object.keys(LABELS) as SchemaType[]).map((t) => <option key={t} value={t}>{LABELS[t]}</option>)}
        </select>
      </Field>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        {SCHEMA_FIELDS[type].map(([k, label]) => (
          <Field key={k} label={label}>
            {k === "sameAs" || k === "faq" || k === "description"
              ? <textarea value={values[k] ?? ""} onChange={(e) => setValues({ ...values, [k]: e.target.value })} rows={3} className={`${inputCls} h-auto py-2`} />
              : <input value={values[k] ?? ""} onChange={(e) => setValues({ ...values, [k]: e.target.value })} className={inputCls} />}
          </Field>
        ))}
      </div>
      <CopyBlock text={`<script type="application/ld+json">\n${json}\n</script>`} label="À coller dans le <head> de la page" />
    </Card>
  );
}


type Indexing = {
  total: number; indexed: number; notIndexed: number; unknown: number; submitted: number; pending: number;
  problems: { url: string; verdict: string | null; coverage: string | null; last_crawl: string | null; error: string | null }[];
  indexnow: { key: string; file: string; verified: boolean; lastSubmit: number | null; lastResult: string | null } | null;
};
const short = (u: string) => u.replace(/^https?:\/\/[^/]+/, "") || "/";

export function IndexingCard({ site, demo }: { site: Site; demo: boolean }) {
  const [data, setData] = useState<Indexing | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "warn" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState("");
  const load = () => api<Indexing>(`/api/sites/${site.id}/indexing`).then(setData).catch((e) => setMsg({ tone: "err", text: (e as Error).message }));
  useEffect(() => { void load(); }, [site.id]);
  const act = async (name: string, path: string, done: (r: any) => string) => {
    setBusy(name); setMsg(null);
    try { const r = await api<any>(path, { method: "POST", json: {} }); setMsg({ tone: r.ok === false || r.found?.error ? "warn" : "ok", text: done(r) }); }
    catch (e) { setMsg({ tone: "err", text: (e as Error).message }); }
    setBusy(""); void load();
  };
  const tiles: [string, number | undefined][] = [["Pages connues", data?.total], ["Indexées chez Google", data?.indexed], ["Non indexées", data?.notIndexed], ["Pas encore vérifiées", data?.unknown], ["À signaler (IndexNow)", data?.pending]];
  return (
    <Card title="Indexation" action={!demo && <Button variant="secondary" disabled={!!busy} onClick={() => act("refresh", `/api/sites/${site.id}/indexing/refresh`,
      (r) => `${r.found.added} page(s) ajoutée(s)${r.found.error ? ` · sitemap : ${r.found.error}` : ""}${r.google ? ` · ${r.google.inspected} vérifiée(s) chez Google` : ""}`)}>{busy === "refresh" ? "Actualisation…" : "Actualiser"}</Button>}>
      <div className="overflow-hidden rounded-xl border border-border"><div className="-mr-px -mb-px grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
        {tiles.map(([label, n]) => <div key={label} className="border-r border-b border-border px-4 py-3"><div className="label-caps truncate">{label}</div><div className="kpi mt-2 text-[26px] font-medium">{n ?? "—"}</div></div>)}
      </div></div>
      {msg && <p role="status" className={`mt-3 text-sm ${msg.tone === "ok" ? "text-positive" : msg.tone === "warn" ? "text-warn" : "text-negative"}`}>{msg.text}</p>}
      {!site.gsc_property && <p className="mt-3 text-sm text-muted">Reliez ce site à Search Console pour lire son état d'indexation chez Google. Le signalement IndexNow fonctionne sans.</p>}
      <p className="mt-3 text-xs text-muted">Google n'a pas d'API d'indexation ouverte à tous : Searchtide lit son état (quelques dizaines de pages par jour) et signale vos pages aux moteurs IndexNow (Bing, Yandex…). Pour Google, déclarez votre sitemap dans Search Console.</p>

      {data && data.problems.length > 0 && (
        <section className="mt-5" aria-labelledby="idx-pb">
          <h3 id="idx-pb" className="mb-2 font-medium">Pages non indexées</h3>
          <ul className="divide-y divide-rule">{data.problems.map((p) => (
            <li key={p.url} className="grid gap-x-4 gap-y-0.5 py-2 text-sm sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <span className="flex min-w-0 items-center gap-2.5"><span aria-hidden className={`led ${p.error ? "led-off" : "led-warn"}`} /><span className="truncate">{short(p.url)}</span></span>
              <span className="text-muted">{p.error ?? p.coverage ?? p.verdict}{p.last_crawl ? ` · exploré le ${new Date(p.last_crawl).toLocaleDateString("fr-FR")}` : ""}</span>
            </li>
          ))}</ul>
        </section>
      )}

      <section className="mt-6 border-t border-rule pt-5" aria-labelledby="idx-now">
        <h3 id="idx-now" className="font-medium">IndexNow : prévenir Bing et les autres moteurs</h3>
        {!data?.indexnow ? (
          <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-muted">
            <span>Une clé à publier sur le site, puis les pages nouvelles ou modifiées sont signalées chaque jour.</span>
            {!demo && <Button variant="secondary" disabled={!!busy} onClick={() => act("verify", `/api/sites/${site.id}/indexnow/verify`, () => "Clé créée : publiez le fichier ci-dessous, puis vérifiez.")}>Activer IndexNow</Button>}
          </div>
        ) : !data.indexnow.verified ? (
          <div className="mt-2 text-sm">
            <p className="text-muted">Publiez à la racine du site un fichier nommé <code className="font-mono break-all text-ink">{data.indexnow.file}</code> qui contient seulement la clé, pour qu'il réponde à <code className="font-mono break-all text-ink">https://{site.domain}/{data.indexnow.file}</code>.</p>
            <CopyBlock text={data.indexnow.key} label="Contenu du fichier" />
            {!demo && <Button className="mt-3" variant="secondary" disabled={!!busy} onClick={() => act("verify", `/api/sites/${site.id}/indexnow/verify`, (r) => r.message)}>{busy === "verify" ? "Vérification…" : "Vérifier le fichier"}</Button>}
          </div>
        ) : (
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            <span className="flex items-center gap-2 text-positive"><span aria-hidden className="led led-ok" />Clé vérifiée</span>
            <span className="text-muted">{data.indexnow.lastSubmit ? `Dernier envoi le ${new Date(data.indexnow.lastSubmit).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" })} : ${data.indexnow.lastResult}` : "Aucun envoi pour l'instant"}</span>
            {!demo && <Button variant="secondary" disabled={!!busy || !data.pending} onClick={() => act("submit", `/api/sites/${site.id}/indexnow/submit`, (r) => `${r.submitted} page(s) signalée(s) : ${r.message}`)}>{busy === "submit" ? "Envoi…" : `Signaler ${data.pending} page(s)`}</Button>}
          </div>
        )}
      </section>
    </Card>
  );
}


type AuditGroup = { type: string; severity: "bad" | "warn" | "info"; label: string; advice: string; count: number; clicks: number; pages: { url: string; detail: string | null; clicks: number; impressions: number }[] };
type Audit = { run: { id: string; state: "running" | "done" | "failed"; pages: number; startedAt: number; finishedAt: number | null; error: string | null } | null; groups: AuditGroup[] };

export function AuditCard({ site, demo }: { site: Site; demo: boolean }) {
  const [data, setData] = useState<Audit | null>(null);
  const [error, setError] = useState("");
  const load = () => api<Audit>(`/api/sites/${site.id}/audit`).then(setData).catch((e) => setError((e as Error).message));
  useEffect(() => { void load(); }, [site.id]);
  const running = data?.run?.state === "running";
  useEffect(() => { if (!running) return; const t = setInterval(() => void load(), 2000); return () => clearInterval(t); }, [running]);
  const start = async () => {
    setError("");
    try { await api(`/api/sites/${site.id}/audit`, { method: "POST", json: {} }); void load(); } catch (e) { setError((e as Error).message); }
  };
  const count = (sev: string) => (data?.groups ?? []).filter((g) => g.severity === sev).reduce((n, g) => n + g.count, 0);
  return (
    <Card title="Audit technique du site" action={!demo && <Button variant="secondary" disabled={running} onClick={start}>{running ? "Audit en cours…" : data?.run ? "Relancer l'audit" : "Lancer l'audit"}</Button>}>
      {error && <p role="alert" className="mb-3 text-sm text-negative">{error}</p>}
      {!data ? <p className="text-sm text-muted">Chargement…</p> : !data.run ? (
        <p className="text-sm text-muted">Le robot parcourt jusqu'à 200 pages de {site.domain} (accueil, liens internes, sitemap) et relève les problèmes qui freinent le référencement, classés par le trafic Google des pages touchées. Quelques minutes.</p>
      ) : running ? (
        <p role="status" className="flex items-center gap-2.5 text-sm"><span aria-hidden className="led led-warn" />{data.run.pages} page(s) explorée(s)…</p>
      ) : data.run.state === "failed" ? (
        <p role="alert" className="text-sm text-negative">L'audit a échoué : {data.run.error}</p>
      ) : (
        <>
          <p className="num text-sm" aria-live="polite">
            <span className="text-muted">{data.run.pages} page{data.run.pages > 1 ? "s" : ""} explorée{data.run.pages > 1 ? "s" : ""} le {new Date(data.run.finishedAt ?? data.run.startedAt).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" })} · </span>
            <span className="text-negative">{count("bad")} à corriger</span> · <span className="text-warn">{count("warn")} à améliorer</span> · <span className="text-muted">{count("info")} à surveiller</span>
          </p>
          {data.groups.length === 0 ? <p className="mt-3 text-sm text-positive">Aucun problème relevé.</p> : (
            <ul className="mt-3 divide-y divide-rule">
              {data.groups.map((g) => (
                <li key={g.type} className="py-3">
                  <details>
                    <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1">
                      <span aria-hidden className={`led ${g.severity === "bad" ? "led-bad" : g.severity === "warn" ? "led-warn" : "led-off"}`} />
                      <span className="font-medium">{g.label}</span>
                      <span className="num text-sm text-muted">{g.count} page{g.count > 1 ? "s" : ""}{g.clicks ? ` · ${fmt(g.clicks)} clics Google en jeu` : ""}</span>
                      <span className="ml-auto text-xs text-muted underline">Voir les pages</span>
                    </summary>
                    <p className="mt-1 pl-[18px] text-sm text-muted">{g.advice}</p>
                    <ul className="mt-2 space-y-1 pl-[18px] text-sm">
                      {g.pages.map((p) => <li key={p.url} className="flex flex-wrap gap-x-3"><a href={p.url} target="_blank" rel="noreferrer" className="min-w-0 truncate hover:underline">{p.url.replace(/^https?:\/\/[^/]+/, "") || "/"}</a>
                        {p.detail && <span className="text-muted">{p.detail}</span>}{p.clicks > 0 && <span className="num text-muted">{fmt(p.clicks)} clics</span>}</li>)}
                    </ul>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}

export function SeoToolsView({ site, demo = false }: { site: Site; demo?: boolean }) {
  return (
    <div className="space-y-4">
      <AuditCard site={site} demo={demo} />
      <PageChecker site={site} />
      <IndexingCard site={site} demo={demo} />
      <div className="grid gap-4 xl:grid-cols-2">
        <RobotsGenerator domain={site.domain} />
        <SchemaGenerator domain={site.domain} />
      </div>
    </div>
  );
}
