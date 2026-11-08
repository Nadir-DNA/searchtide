import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, AuthError, type Overview as OverviewData, type Search, type Site, type Traffic } from "./api";
import { LineChart, fillDays } from "./chart";
import { Button, Delta, EmptyBox, KpiStrip, Mark, Section, ShareTable, Skeleton, Table, fieldCls, fmt, inputCls } from "./ui";

const CHANNELS: Record<string, string> = {
  direct: "Accès direct", search: "Moteurs de recherche", social: "Réseaux sociaux", ai: "Assistants IA",
  referral: "Liens depuis d'autres sites", email: "Email", paid: "Publicité",
};
const PERIODS = [[7, "7 derniers jours"], [28, "28 derniers jours"], [90, "3 derniers mois"], [365, "12 derniers mois"]] as const;
const periodWord = (days: number) => `vs ${days} j précédents`;

type Me = { gsc: boolean; demo: boolean };

// Navigation par l'URL : ?site=exemple.com&tab=search&days=28
function useRoute() {
  const read = () => Object.fromEntries(new URLSearchParams(location.search)) as Record<string, string>;
  const [q, setQ] = useState(read);
  useEffect(() => { const f = () => setQ(read()); addEventListener("popstate", f); return () => removeEventListener("popstate", f); }, []);
  const go = (next: Record<string, string | undefined>) => {
    const p = new URLSearchParams({ ...q, ...next } as Record<string, string>);
    for (const [k, v] of [...p]) if (!v || v === "undefined") p.delete(k);
    history.pushState(null, "", p.size ? `?${p}` : location.pathname);
    setQ(read());
  };
  return { q, go };
}

export function App() {
  const [me, setMe] = useState<Me | null | false>(null);
  useEffect(() => { api<Me>("/api/me").then(setMe).catch(() => setMe(false)); }, []);
  if (me === null) return null;
  return me ? <Shell me={me} onLogout={() => setMe(false)} /> : <Login />;
}

function Login() {
  const [error, setError] = useState("");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    try { await api("/api/login", { method: "POST", json: { password: new FormData(e.currentTarget).get("password") } }); location.reload(); }
    catch (err) { setError((err as Error).message); }
  }
  return (
    <main className="grid min-h-screen place-items-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-border bg-surface p-8">
        <div className="mb-6 flex items-center gap-2"><Mark className="size-7" /><span className="text-base font-semibold">Searchtide</span></div>
        <h1 className="text-[22px] font-semibold">Connexion</h1>
        <p className="mt-1 mb-6 text-sm text-muted">Le mot de passe est défini par ADMIN_PASSWORD sur votre instance.</p>
        <label className="block text-sm font-medium">Mot de passe
          <input name="password" type="password" autoFocus required className={`${inputCls} mt-2 h-10`} />
        </label>
        {error && <p role="alert" className="mt-2 text-sm text-negative">{error}</p>}
        <Button className="mt-4 h-10 w-full justify-center">Se connecter</Button>
      </form>
    </main>
  );
}

function Shell({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const { q, go } = useRoute();
  const [sites, setSites] = useState<Site[] | null>(null);
  const [menu, setMenu] = useState(false);
  const load = useCallback(() => api<Site[]>("/api/sites").then(setSites).catch((e) => e instanceof AuthError && onLogout()), [onLogout]);
  useEffect(() => { load(); }, [load]);
  const days = Number(q.days) || 28;
  const site = sites?.find((s) => s.domain === q.site);
  const nav = (next: Record<string, string | undefined>) => { setMenu(false); go(next); };

  const sidebar = (
    <nav aria-label="Navigation" className="flex h-full flex-col gap-1 px-3 pb-4">
      <NavItem active={!q.site && q.view !== "add"} onClick={() => nav({ site: undefined, tab: undefined, view: undefined })}>Vue d'ensemble</NavItem>
      <div className="mt-5 mb-1 px-2.5 text-xs text-muted">Sites</div>
      {sites?.map((s) => (
        <NavItem key={s.id} active={s.domain === q.site} onClick={() => nav({ site: s.domain, view: undefined })}>
          <span className="truncate">{s.domain}</span>
          {s.today > 0 && <span className="ml-auto size-1.5 shrink-0 rounded-full bg-positive" title="Visites aujourd'hui" />}
        </NavItem>
      ))}
      {!me.demo && <NavItem active={q.view === "add"} onClick={() => nav({ site: undefined, view: "add" })}><span className="text-muted">+ Ajouter un site</span></NavItem>}
      <div className="mt-auto space-y-1 pt-4">
        <a href="https://github.com/Nadir-DNA/searchtide" target="_blank" rel="noreferrer" className="block rounded-md px-2.5 py-1.5 text-sm text-muted hover:bg-active">Documentation</a>
        {!me.demo && <button onClick={() => api("/api/logout", { method: "POST" }).then(onLogout)} className="block w-full rounded-md px-2.5 py-1.5 text-left text-sm text-muted hover:bg-active">Déconnexion</button>}
      </div>
    </nav>
  );

  return (
    <div className="flex min-h-screen">
      {/* Cadre : barre latérale + barre du haut sur le même fond teinté, sans trait entre les deux */}
      <aside className="sticky top-0 hidden h-screen w-[228px] shrink-0 flex-col md:flex">
        <div className="flex h-12 items-center gap-2 px-5"><Mark className="size-6" /><span className="font-semibold">Searchtide</span></div>
        {sidebar}
      </aside>
      {menu && (
        <div className="fixed inset-0 z-20 flex flex-col bg-ground md:hidden">
          <div className="flex h-12 items-center justify-between px-4">
            <span className="flex items-center gap-2"><Mark className="size-6" /><span className="font-semibold">Searchtide</span></span>
            <button onClick={() => setMenu(false)} className="h-11 px-2 text-sm">Fermer</button>
          </div>
          {sidebar}
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 items-center gap-3 px-4 md:pr-2 md:pl-0">
          <button onClick={() => setMenu(true)} className="-ml-2 flex h-11 items-center gap-2 px-2 md:hidden" aria-label="Ouvrir le menu">
            <Mark className="size-6" /><span className="text-sm">Menu</span>
          </button>
          <div className="hidden min-w-0 items-center gap-1.5 text-sm text-muted md:flex">
            <span>Searchtide</span><span aria-hidden>/</span><span className="truncate text-ink">{site?.domain ?? (q.view === "add" ? "Ajouter un site" : "Vue d'ensemble")}</span>
          </div>
          {me.demo && <span className="hidden rounded bg-active px-2 py-0.5 text-xs text-muted sm:inline">Démo en lecture seule</span>}
          <select value={days} onChange={(e) => go({ days: e.target.value })} className={`${fieldCls} ml-auto`} aria-label="Période">
            {PERIODS.map(([d, l]) => <option key={d} value={d}>{l}</option>)}
          </select>
        </header>
        {/* La feuille : décalée de 8 px des bords droit et bas, angle 16 px, un trait, pas d'ombre */}
        <main className="min-w-0 flex-1 border-border bg-surface px-4 py-6 md:mr-2 md:mb-2 md:rounded-2xl md:border md:px-8 md:py-7">
          {sites === null ? null
            : q.view === "add" ? <AddSite onAdded={(s) => { load(); go({ site: s.domain, tab: "setup", view: undefined }); }} />
            : site ? <SiteView key={site.id} site={site} me={me} days={days} tab={q.tab ?? "traffic"} go={go} onChange={load} />
            : <Overview days={days} demo={me.demo} onOpen={(d) => go({ site: d })} onAdd={() => go({ view: "add" })} />}
        </main>
      </div>
    </div>
  );
}

function NavItem({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick} aria-current={active ? "page" : undefined}
      className={`flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-sm transition-colors ${active ? "bg-active font-medium" : "text-ink/80 hover:bg-active/60"}`}>
      {children}
    </button>
  );
}

function useData<T>(url: string) {
  const [state, setState] = useState<{ data: T | null; error: string }>({ data: null, error: "" });
  const reload = useCallback(() => {
    api<T>(url).then((data) => setState({ data, error: "" })).catch((e) => setState((s) => ({ ...s, error: e.message })));
  }, [url]);
  useEffect(reload, [reload]);
  return { ...state, reload };
}

function TitleRow({ title, sub, action }: { title: ReactNode; sub?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="truncate text-[22px] leading-7 font-semibold">{title}</h1>
        {sub && <p className="mt-1 text-sm text-muted">{sub}</p>}
      </div>
      {action}
    </div>
  );
}

function ErrorLine({ error, retry }: { error: string; retry: () => void }) {
  return <EmptyBox>Impossible de charger les données : {error}. <button onClick={retry} className="font-medium text-ink underline">Réessayer</button></EmptyBox>;
}

// ── Vue d'ensemble : tous les sites ──
function Overview({ days, demo, onOpen, onAdd }: { days: number; demo: boolean; onOpen: (d: string) => void; onAdd: () => void }) {
  const { data: o, error, reload } = useData<OverviewData>(`/api/overview?days=${days}`);
  const data = o?.sites;
  const visitors = data?.reduce((n, s) => n + s.traffic.visitors, 0) ?? 0;
  const ai = data?.reduce((n, s) => n + s.traffic.ai, 0) ?? 0;
  const best = data?.slice().sort((a, b) => b.traffic.visitors - a.traffic.visitors)[0];
  return (
    <>
      <TitleRow title="Vue d'ensemble"
        sub={data?.length ? `${fmt(visitors)} visiteurs sur ${days} jours, dont ${fmt(ai)} venus d'assistants IA${best?.traffic.visitors ? ` · ${best.domain} en tête` : ""}` : undefined}
        action={!demo && <Button onClick={onAdd}>Ajouter un site</Button>} />
      {error ? <ErrorLine error={error} retry={reload} /> : !data ? <Skeleton className="h-40" /> : !data.length ? (
        <EmptyBox>Aucun site pour l'instant. Ajoutez votre premier site pour obtenir le script de suivi.</EmptyBox>
      ) : (
        <div className="space-y-10">
        <Section title="Visiteurs par jour, tous sites confondus">
          <LineChart label="Visiteurs, tous sites" {...fillDays(o!.daily, o!.range.from, o!.range.to, (d) => d.visitors)} />
        </Section>
        <Section title="Sites" sub="Cliquez sur un site pour voir son trafic et ses mots-clés Google.">
        <Table rows={data} onRow={(s) => onOpen(s.domain)} empty="" cols={[
          { label: "Site", className: "w-1/3", render: (s) => <span className="flex items-center gap-2 font-medium">{s.domain}{s.today > 0 && <span className="text-xs font-normal text-muted">· {fmt(s.today)} aujourd'hui</span>}</span> },
          { label: "Visiteurs", num: true, render: (s) => fmt(s.traffic.visitors) },
          { label: "Évolution", num: true, render: (s) => <Delta now={s.traffic.visitors} before={s.trafficPrev.visitors} window="" /> },
          { label: "Pages vues", num: true, render: (s) => fmt(s.traffic.pageviews) },
          { label: "Depuis les IA", num: true, render: (s) => fmt(s.traffic.ai) },
          { label: "Clics Google", num: true, render: (s) => s.search ? fmt(s.search.clicks) : <span className="text-muted">—</span> },
          { label: "Position moy.", num: true, render: (s) => s.search?.position != null ? fmt(s.search.position, 1) : <span className="text-muted">—</span> },
        ]} />
        </Section>
        </div>
      )}
    </>
  );
}

function AddSite({ onAdded }: { onAdded: (s: Site) => void }) {
  const [error, setError] = useState("");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    try { onAdded(await api<Site>("/api/sites", { method: "POST", json: { domain: new FormData(e.currentTarget).get("domain") } })); }
    catch (err) { setError((err as Error).message); }
  }
  return (
    <>
      <TitleRow title="Ajouter un site" sub="Vous obtiendrez ensuite le script à coller dans le site." />
      <form onSubmit={submit} className="max-w-md">
        <label className="block text-sm font-medium">Domaine
          <input name="domain" placeholder="exemple.com" required autoFocus className={`${inputCls} mt-2 h-10`} />
        </label>
        <p className="mt-2 text-xs text-muted">Sans https:// ni www. Les sous-domaines sont comptés avec le domaine.</p>
        {error && <p role="alert" className="mt-2 text-sm text-negative">{error}</p>}
        <Button className="mt-4">Ajouter le site</Button>
      </form>
    </>
  );
}

// ── Un site ──
function SiteView({ site, me, days, tab, go, onChange }: {
  site: Site; me: Me; days: number; tab: string; go: (n: Record<string, string | undefined>) => void; onChange: () => void;
}) {
  const tabs = [["traffic", "Trafic"], ["search", "Recherche Google"], ["setup", "Installation"]] as const;
  const { data: t } = useData<Traffic>(`/api/sites/${site.id}/traffic?days=${days}`);
  const top = t?.pages[0];
  const finding = t?.totals.visitors
    ? `${fmt(t.totals.visitors)} visiteurs sur ${days} jours · ${fmt((t.totals.ai / t.totals.visitors) * 100)} % venus d'assistants IA${top ? ` · page la plus vue : ${top.key}` : ""}`
    : undefined;
  return (
    <>
      <TitleRow title={site.domain} sub={finding}
        action={<a href={`https://${site.domain}`} target="_blank" rel="noreferrer" className="text-sm text-muted hover:text-ink">Ouvrir le site ↗</a>} />
      <div role="tablist" className="-mt-2 mb-7 flex gap-6 border-b border-border">
        {tabs.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => go({ tab: k === "traffic" ? undefined : k })}
            className={`-mb-px h-10 border-b-2 text-sm transition-colors ${tab === k ? "border-ink font-medium" : "border-transparent text-muted hover:text-ink"}`}>{l}</button>
        ))}
      </div>
      {tab === "search" ? <SearchView site={site} me={me} days={days} onChange={onChange} onSetup={() => go({ tab: "setup" })} />
        : tab === "setup" ? <SetupView site={site} me={me} onChange={onChange} />
        : <TrafficView site={site} days={days} onSetup={() => go({ tab: "setup" })} />}
    </>
  );
}

function KpiSkeleton() {
  return <div className="grid grid-cols-2 gap-6 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <div key={i} className="space-y-2 pt-3"><Skeleton className="h-3 w-20" /><Skeleton className="h-8 w-24" /></div>)}</div>;
}

function TrafficView({ site, days, onSetup }: { site: Site; days: number; onSetup: () => void }) {
  const { data: t, error, reload } = useData<Traffic>(`/api/sites/${site.id}/traffic?days=${days}`);
  const [metric, setMetric] = useState<"visitors" | "pageviews">("visitors");
  if (error) return <ErrorLine error={error} retry={reload} />;
  if (!t) return <KpiSkeleton />;
  if (!t.totals.pageviews && !t.previous.pageviews) {
    return (
      <EmptyBox>
        Aucune visite sur cette période. Si vous venez d'ajouter le site, collez le script de suivi puis ouvrez une page du site.{" "}
        <button onClick={onSetup} className="font-medium text-ink underline">Voir le script</button>
      </EmptyBox>
    );
  }
  const w = periodWord(days);
  const chart = fillDays(t.daily, t.range.from, t.range.to, (d) => d[metric]);
  return (
    <div className="space-y-10">
      <KpiStrip selected={metric} selectable={["visitors", "pageviews"]} onSelect={(id) => setMetric(id as typeof metric)} items={[
        { id: "visitors", label: "Visiteurs", value: fmt(t.totals.visitors), delta: <Delta now={t.totals.visitors} before={t.previous.visitors} window={w} /> },
        { id: "pageviews", label: "Pages vues", value: fmt(t.totals.pageviews), delta: <Delta now={t.totals.pageviews} before={t.previous.pageviews} window={w} /> },
        { id: "ppv", label: "Pages par visiteur", value: t.totals.visitors ? fmt(t.totals.pageviews / t.totals.visitors, 1) : "—" },
        { id: "ai", label: "Venus d'assistants IA", value: fmt(t.totals.ai), delta: <Delta now={t.totals.ai} before={t.previous.ai} window={w} /> },
      ]} />
      <LineChart days={chart.days} values={chart.values} label={metric === "visitors" ? "Visiteurs" : "Pages vues"} />
      <div className="grid gap-x-10 gap-y-10 lg:grid-cols-2">
        <ShareTable title="Pages" label="Page" rows={t.pages} empty="Aucune page vue sur cette période." />
        <ShareTable title="Provenance" label="Canal" rows={t.channels} map={(k) => CHANNELS[k] ?? k} empty="Aucune visite sur cette période." />
        <ShareTable title="Sites référents" label="Site" rows={t.referrers} empty="Aucun lien depuis un autre site sur cette période." />
        <ShareTable title="Assistants IA" label="Assistant" rows={t.aiReferrers} empty="Personne n'est arrivé depuis ChatGPT, Perplexity, Claude ou Gemini sur cette période." />
        <ShareTable title="Pays" label="Pays" rows={t.countries} map={countryName} empty="Pays inconnus : placez l'instance derrière Cloudflare pour les obtenir." />
        <ShareTable title="Appareils" label="Appareil" rows={t.devices} empty="Aucune donnée." />
        <ShareTable title="Navigateurs" label="Navigateur" rows={t.browsers} empty="Aucune donnée." />
        <ShareTable title="Campagnes" label="utm_campaign" rows={t.campaigns} empty="Aucune visite avec un paramètre utm_campaign." />
      </div>
    </div>
  );
}

const regionNames = new Intl.DisplayNames(["fr"], { type: "region" });
const countryName = (code: string) => { try { return regionNames.of(code) ?? code; } catch { return code; } };

function SearchView({ site, me, days, onChange, onSetup }: { site: Site; me: Me; days: number; onChange: () => void; onSetup: () => void }) {
  const linked = me.gsc && !!site.gsc_property;
  const { data: s, error, reload } = useData<Search>(`/api/sites/${site.id}/search?days=${days}`);
  const [metric, setMetric] = useState<"clicks" | "impressions">("clicks");
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState("");
  async function sync() {
    setSyncing(true); setSyncError("");
    try { await api(`/api/sites/${site.id}/sync`, { method: "POST" }); reload(); onChange(); }
    catch (e) { setSyncError((e as Error).message); }
    setSyncing(false);
  }
  if (!linked) {
    return (
      <EmptyBox>
        Ce site n'est pas encore relié à Google Search Console : c'est elle qui donne les mots-clés, les clics et la position de chaque page.{" "}
        <button onClick={onSetup} className="font-medium text-ink underline">Relier Search Console</button>
      </EmptyBox>
    );
  }
  if (error) return <ErrorLine error={error} retry={reload} />;
  if (!s) return <KpiSkeleton />;
  const w = periodWord(days);
  // Google publie avec 2-3 jours de retard : l'axe s'arrête au dernier jour publié au lieu de tomber à zéro
  const chart = fillDays(s.daily, s.range.from, s.daily.at(-1)?.day ?? s.range.to, (d) => d[metric]);
  return (
    <div className="space-y-10">
      <div className="-mt-3 flex flex-wrap items-center gap-3 text-sm text-muted">
        <span className={`size-1.5 rounded-full ${site.sync_error ? "bg-negative" : "bg-positive"}`} aria-hidden />
        <span>{site.synced_at ? `Données Google importées le ${new Date(site.synced_at).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" })}` : "Pas encore importé"} · Google publie avec 2 à 3 jours de retard</span>
        {!me.demo && <Button variant="secondary" onClick={sync} disabled={syncing} className="ml-auto">{syncing ? "Import en cours…" : "Importer maintenant"}</Button>}
      </div>
      {(syncError || site.sync_error) && <p role="alert" className="-mt-6 text-sm text-negative">{syncError || site.sync_error}</p>}
      <KpiStrip selected={metric} selectable={["clicks", "impressions"]} onSelect={(id) => setMetric(id as typeof metric)} items={[
        { id: "clicks", label: "Clics", value: fmt(s.totals.clicks), delta: <Delta now={s.totals.clicks} before={s.previous.clicks} window={w} /> },
        { id: "impressions", label: "Impressions", value: fmt(s.totals.impressions), delta: <Delta now={s.totals.impressions} before={s.previous.impressions} window={w} /> },
        { id: "ctr", label: "Taux de clic", value: s.totals.ctr != null ? `${fmt(s.totals.ctr, 1)} %` : "—" },
        { id: "position", label: "Position moyenne", value: fmt(s.totals.position, 1), delta: <Delta now={s.totals.position} before={s.previous.position} lowerIsBetter window={w} /> },
      ]} />
      <LineChart days={chart.days} values={chart.values} label={metric === "clicks" ? "Clics" : "Impressions"} />
      <Section title="À travailler en priorité" sub="Mots-clés en position 4 à 20 qui ont déjà des impressions : un effort sur la page peut les faire passer en première page.">
        <Table rows={s.opportunities.slice(0, 8)} empty="Aucun mot-clé entre la 4e et la 20e position sur cette période." cols={[
          { label: "Mot-clé", className: "w-1/2", render: (r) => r.query },
          { label: "Impressions", num: true, render: (r) => fmt(r.impressions) },
          { label: "Clics", num: true, render: (r) => fmt(r.clicks) },
          { label: "Position", num: true, render: (r) => fmt(r.position, 1) },
        ]} />
      </Section>
      <div className="grid gap-x-10 gap-y-10 lg:grid-cols-2">
        <Section title="Mots-clés">
          <Table rows={s.queries.slice(0, 8)} empty="Aucun mot-clé sur cette période." cols={[
            { label: "Mot-clé", className: "w-1/2", render: (r) => r.query },
            { label: "Clics", num: true, render: (r) => fmt(r.clicks) },
            { label: "Impr.", num: true, render: (r) => fmt(r.impressions) },
            { label: "Position", num: true, render: (r) => fmt(r.position, 1) },
          ]} />
        </Section>
        <Section title="Pages">
          <Table rows={s.pages.slice(0, 8)} empty="Aucune page sur cette période." cols={[
            { label: "Page", className: "w-1/2", render: (r) => r.page.replace(/^https?:\/\/[^/]+/, "") || "/" },
            { label: "Clics", num: true, render: (r) => fmt(r.clicks) },
            { label: "Impr.", num: true, render: (r) => fmt(r.impressions) },
            { label: "Position", num: true, render: (r) => fmt(r.position, 1) },
          ]} />
        </Section>
      </div>
    </div>
  );
}

function SettingRow({ title, sub, children }: { title: string; sub: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-4 border-t border-border py-8 first:border-t-0 first:pt-0 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:gap-10">
      <div><h2 className="text-base font-medium">{title}</h2><p className="mt-1 text-sm text-muted">{sub}</p></div>
      <div className="min-w-0 rounded-2xl bg-raised p-4">{children}</div>
    </div>
  );
}

function Copyable({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="flex items-start gap-2">
      <pre className="min-w-0 flex-1 overflow-x-auto rounded-lg border border-border bg-surface px-3 py-2.5 font-mono text-xs leading-5"><code>{text}</code></pre>
      <Button variant="secondary" onClick={() => navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); })}>
        {done ? "Copié" : "Copier"}
      </Button>
    </div>
  );
}

function SetupView({ site, me, onChange }: { site: Site; me: Me; onChange: () => void }) {
  const [props, setProps] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { if (me.gsc && !me.demo) api<string[]>("/api/gsc/properties").then(setProps).catch((e) => setError(e.message)); }, [me]);
  async function link(gsc_property: string) {
    await api(`/api/sites/${site.id}`, { method: "PATCH", json: { gsc_property } });
    onChange();
  }
  async function remove() {
    if (!confirm(`Supprimer ${site.domain} et toutes ses statistiques ? Cette action est définitive.`)) return;
    await api(`/api/sites/${site.id}`, { method: "DELETE" });
    location.search = "";
  }
  return (
    <div>
      <SettingRow title="Script de suivi" sub={<>À coller dans le &lt;head&gt; de chaque page. Sans cookie : aucune bannière de consentement n'est nécessaire.</>}>
        <Copyable text={`<script defer src="${location.origin}/script.js" data-site="${site.domain}"></script>`} />
        <p className="mt-3 text-xs text-muted">Pour compter une action : <code className="font-mono">searchtide("inscription")</code> en JavaScript, ou l'attribut <code className="font-mono">data-searchtide="clic-cta"</code> sur un bouton.</p>
      </SettingRow>
      <SettingRow title="Google Search Console" sub="Mots-clés, clics, impressions et position de chaque page. Importés automatiquement toutes les 6 heures.">
        {!me.gsc ? (
          <p className="text-sm">Non configuré sur cette instance : renseignez <code className="font-mono text-xs">GOOGLE_SERVICE_ACCOUNT_JSON</code> puis redémarrez (voir la documentation).</p>
        ) : error ? <p role="alert" className="text-sm text-negative">{error}</p> : (
          <label className="block text-sm font-medium">Propriété Search Console
            <select className={`${inputCls} mt-2 h-10`} value={site.gsc_property ?? ""} disabled={me.demo} onChange={(e) => link(e.target.value)}>
              <option value="">Non reliée</option>
              {site.gsc_property && !props?.includes(site.gsc_property) && <option value={site.gsc_property}>{site.gsc_property}</option>}
              {props?.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            {props?.length === 0 && <span className="mt-2 block text-xs font-normal text-muted">Aucune propriété visible : ajoutez l'email du compte de service comme utilisateur du site dans Search Console.</span>}
          </label>
        )}
      </SettingRow>
      <SettingRow title="Agents IA" sub="Vos agents (Claude, Cursor…) lisent les statistiques par le serveur MCP de l'instance, avec la clé API_KEY.">
        <Copyable text={`claude mcp add --transport http searchtide ${location.origin}/mcp --header "Authorization: Bearer VOTRE_CLE"`} />
      </SettingRow>
      {!me.demo && (
        <SettingRow title="Supprimer le site" sub="Efface le site et toutes ses statistiques. Définitif.">
          <button onClick={remove} className="h-8 rounded-md border border-negative/40 px-3 text-sm font-medium text-negative hover:bg-negative/5">Supprimer {site.domain}</button>
        </SettingRow>
      )}
    </div>
  );
}
