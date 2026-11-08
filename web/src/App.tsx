import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, AuthError, type Overview as OverviewData, type Search, type Site, type Traffic } from "./api";
import { BarChart, Donut, fillDays } from "./chart";
import { Button, Card, Delta, EmptyBox, Icon, KpiCard, Mark, Segmented, ShareList, Skeleton, Svg, Table, fmt, inputCls } from "./ui";

const CHANNELS: Record<string, string> = {
  direct: "Accès direct", search: "Moteurs de recherche", social: "Réseaux sociaux", ai: "Assistants IA",
  referral: "Autres sites", email: "Email", paid: "Publicité",
};
const PERIODS = [["7", "7 j"], ["28", "28 j"], ["90", "3 mois"], ["365", "12 mois"]] as const;

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

function useTheme() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? "dark");
  const set = (t: string) => {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem("st-theme", t); } catch { /* navigation privée : le choix reste pour la session */ }
    setTheme(t);
  };
  return [theme, set] as const;
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
      <form onSubmit={submit} className="w-full max-w-sm rounded-[24px] border border-border bg-surface p-8">
        <div className="mb-8 flex items-center gap-2.5"><Mark className="size-8" /><span className="text-lg">Searchtide</span></div>
        <h1 className="text-[28px] font-light">Connexion</h1>
        <p className="mt-1 mb-6 text-sm text-muted">Le mot de passe est défini par ADMIN_PASSWORD sur votre instance.</p>
        <label className="block text-sm">Mot de passe
          <input name="password" type="password" autoFocus required className={`${inputCls} mt-2`} />
        </label>
        {error && <p role="alert" className="mt-2 text-sm text-negative">{error}</p>}
        <Button className="mt-5 w-full">Se connecter</Button>
      </form>
    </main>
  );
}

function Shell({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const { q, go } = useRoute();
  const [theme, setTheme] = useTheme();
  const [sites, setSites] = useState<Site[] | null>(null);
  const [menu, setMenu] = useState(false);
  const load = useCallback(() => api<Site[]>("/api/sites").then(setSites).catch((e) => e instanceof AuthError && onLogout()), [onLogout]);
  useEffect(() => { load(); }, [load]);
  const days = Number(q.days) || 28;
  const site = sites?.find((s) => s.domain === q.site);
  const nav = (next: Record<string, string | undefined>) => { setMenu(false); go(next); };

  const sidebar = (
    <nav aria-label="Navigation" className="flex flex-1 flex-col gap-1 px-4 pb-5">
      <NavItem icon={Icon.grid} active={!q.site && q.view !== "add"} onClick={() => nav({ site: undefined, tab: undefined, view: undefined })}>Vue d'ensemble</NavItem>
      <div className="mt-6 mb-1.5 px-3 text-xs text-muted">Sites</div>
      {sites?.map((s) => (
        <NavItem key={s.id} icon={Icon.globe} active={s.domain === q.site} onClick={() => nav({ site: s.domain, view: undefined })}>
          <span className="truncate">{s.domain}</span>
          {s.today > 0 && <span className="num ml-auto text-xs text-muted" title="Visiteurs aujourd'hui">{fmt(s.today)}</span>}
        </NavItem>
      ))}
      {!me.demo && <NavItem icon={Icon.plus} active={q.view === "add"} onClick={() => nav({ site: undefined, view: "add" })}>Ajouter un site</NavItem>}
      <div className="mt-auto space-y-1 pt-6">
        <a href="https://github.com/Nadir-DNA/searchtide" target="_blank" rel="noreferrer" className="flex h-10 items-center gap-3 rounded-xl px-3 text-sm text-muted hover:text-ink"><Svg>{Icon.book}</Svg>Documentation</a>
        {!me.demo && <button onClick={() => api("/api/logout", { method: "POST" }).then(onLogout)} className="flex h-10 w-full items-center gap-3 rounded-xl px-3 text-sm text-muted hover:text-ink"><Svg>{Icon.out}</Svg>Déconnexion</button>}
        <div className="flex items-center justify-between rounded-2xl border border-border bg-surface px-3 py-2 text-sm">
          <span className="text-muted">Thème</span>
          <Segmented label="Thème" value={theme} onChange={setTheme} options={[["light", "Clair"], ["dark", "Sombre"]] as const} />
        </div>
      </div>
    </nav>
  );

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-[248px] shrink-0 flex-col md:flex">
        <div className="flex h-20 items-center gap-2.5 px-7"><Mark className="size-7" /><span className="text-lg">Searchtide</span></div>
        {sidebar}
      </aside>
      {menu && (
        <div className="fixed inset-0 z-20 flex flex-col bg-ground md:hidden">
          <div className="flex h-14 items-center justify-between px-4">
            <span className="flex items-center gap-2.5"><Mark className="size-7" /><span className="text-lg">Searchtide</span></span>
            <button onClick={() => setMenu(false)} className="h-11 px-2 text-sm">Fermer</button>
          </div>
          {sidebar}
        </div>
      )}
      <div className="min-w-0 flex-1 px-4 pb-10 md:pr-8 md:pl-2">
        <div className="flex h-14 items-center md:hidden">
          <button onClick={() => setMenu(true)} className="-ml-2 flex h-11 items-center gap-2.5 px-2" aria-label="Ouvrir le menu">
            <Mark className="size-7" /><span>Menu</span>
          </button>
          {me.demo && <span className="ml-auto text-xs text-muted">Démo</span>}
        </div>
        {sites === null ? null
          : q.view === "add" ? <AddSite onAdded={(s) => { load(); go({ site: s.domain, tab: "setup", view: undefined }); }} />
          : site ? <SiteView key={site.id} site={site} me={me} days={days} tab={q.tab ?? "traffic"} go={go} onChange={load} />
          : <Overview days={days} demo={me.demo} go={go} />}
      </div>
    </div>
  );
}

function NavItem({ icon, active, onClick, children }: { icon: ReactNode; active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick} aria-current={active ? "page" : undefined}
      className={`relative flex h-10 w-full items-center gap-3 rounded-xl px-3 text-left text-sm transition-colors ${active ? "bg-surface text-ink" : "text-muted hover:text-ink"}`}>
      {active && <span className="absolute top-2.5 -left-4 h-5 w-[3px] rounded-r-full bg-accent" aria-hidden />}
      <Svg>{icon}</Svg>{children}
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

function Header({ title, sub, days, go, demo, children }: {
  title: ReactNode; sub?: ReactNode; days?: number; go?: (n: Record<string, string | undefined>) => void; demo?: boolean; children?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-4 pt-4 pb-6 md:min-h-20 md:pt-6">
      <div className="min-w-0">
        <div className="flex items-center gap-3">
          <h1 className="truncate text-2xl leading-9 font-light md:text-[30px] md:leading-10">{title}</h1>
          {demo && <span className="hidden rounded-full border border-border px-2.5 py-0.5 text-xs text-muted md:inline">Démo en lecture seule</span>}
        </div>
        {sub && <p className="mt-1 text-sm text-muted">{sub}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {children}
        {days && go && <Segmented label="Période" value={String(days)} onChange={(v) => go({ days: v })} options={PERIODS} />}
      </div>
    </header>
  );
}

function ErrorLine({ error, retry }: { error: string; retry: () => void }) {
  return <EmptyBox>Impossible de charger les données : {error}. <button onClick={retry} className="text-ink underline">Réessayer</button></EmptyBox>;
}

function KpiSkeleton() {
  return <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <div key={i} className="space-y-3 rounded-[20px] border border-border bg-surface p-5"><Skeleton className="h-4 w-20" /><Skeleton className="h-9 w-28" /></div>)}</div>;
}

// ── Vue d'ensemble : tous les sites ──
function Overview({ days, demo, go }: { days: number; demo: boolean; go: (n: Record<string, string | undefined>) => void }) {
  const { data: o, error, reload } = useData<OverviewData>(`/api/overview?days=${days}`);
  const sites = o?.sites;
  const sum = (f: (s: NonNullable<typeof sites>[number]) => number) => sites?.reduce((n, s) => n + f(s), 0) ?? 0;
  const visitors = sum((s) => s.traffic.visitors), prev = sum((s) => s.trafficPrev.visitors);
  const linked = sites?.filter((s) => s.search) ?? [];
  return (
    <>
      <Header title="Vue d'ensemble" days={days} go={go} demo={demo}
        sub={sites?.length ? `${sites.length} site${sites.length > 1 ? "s" : ""} suivi${sites.length > 1 ? "s" : ""} · ${days} derniers jours` : undefined}>
        {!demo && <Button onClick={() => go({ view: "add" })}>Ajouter un site</Button>}
      </Header>
      {error ? <ErrorLine error={error} retry={reload} /> : !o ? <KpiSkeleton /> : !sites!.length ? (
        <EmptyBox>Aucun site pour l'instant. Ajoutez votre premier site pour obtenir le script de suivi.</EmptyBox>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <KpiCard label="Visiteurs" value={fmt(visitors)} delta={<Delta now={visitors} before={prev} />} />
            <KpiCard label="Pages vues" value={fmt(sum((s) => s.traffic.pageviews))} delta={<Delta now={sum((s) => s.traffic.pageviews)} before={sum((s) => s.trafficPrev.pageviews)} />} />
            <KpiCard label="Venus d'assistants IA" value={fmt(sum((s) => s.traffic.ai))} delta={<Delta now={sum((s) => s.traffic.ai)} before={sum((s) => s.trafficPrev.ai)} />} />
            <KpiCard label="Clics Google" value={linked.length ? fmt(linked.reduce((n, s) => n + s.search!.clicks, 0)) : "—"}
              hint={linked.length ? `${linked.length} site${linked.length > 1 ? "s" : ""} relié${linked.length > 1 ? "s" : ""} à Search Console` : "Aucun site relié à Search Console"} />
          </div>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <Card title="Visiteurs, tous sites" action={<Delta now={visitors} before={prev} />}>
              <BarChart label="Visiteurs, tous sites" {...fillDays(o.daily, o.range.from, o.range.to, (d) => d.visitors)} />
            </Card>
            <Card title="Répartition par site">
              {visitors ? <Donut total={visitors} totalLabel="visiteurs" parts={sites!.map((s) => ({ label: s.domain, value: s.traffic.visitors }))} />
                : <EmptyBox>Aucune visite sur la période.</EmptyBox>}
            </Card>
          </div>
          <Card title="Sites">
            <Table rows={sites!} onRow={(s) => go({ site: s.domain })} empty="" cols={[
              { label: "Site", className: "w-1/3", render: (s) => <span className="flex items-center gap-2.5"><span className={`size-2 shrink-0 rounded-full ${s.today ? "bg-accent" : "bg-control"}`} title={s.today ? "Visites aujourd'hui" : "Aucune visite aujourd'hui"} />{s.domain}</span> },
              { label: "Visiteurs", num: true, render: (s) => fmt(s.traffic.visitors) },
              { label: "Évolution", num: true, render: (s) => <Delta now={s.traffic.visitors} before={s.trafficPrev.visitors} /> },
              { label: "Pages vues", num: true, render: (s) => fmt(s.traffic.pageviews) },
              { label: "Depuis les IA", num: true, render: (s) => fmt(s.traffic.ai) },
              { label: "Clics Google", num: true, render: (s) => s.search ? fmt(s.search.clicks) : <span className="text-muted">—</span> },
              { label: "Position moy.", num: true, render: (s) => s.search?.position != null ? fmt(s.search.position, 1) : <span className="text-muted">—</span> },
            ]} />
          </Card>
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
      <Header title="Ajouter un site" sub="Vous obtiendrez ensuite le script à coller dans le site." />
      <Card className="max-w-lg">
        <form onSubmit={submit}>
          <label className="block text-sm">Domaine
            <input name="domain" placeholder="exemple.com" required autoFocus className={`${inputCls} mt-2`} />
          </label>
          <p className="mt-2 text-xs text-muted">Sans https:// ni www. Les sous-domaines sont comptés avec le domaine.</p>
          {error && <p role="alert" className="mt-2 text-sm text-negative">{error}</p>}
          <Button className="mt-5">Ajouter le site</Button>
        </form>
      </Card>
    </>
  );
}

// ── Un site ──
function SiteView({ site, me, days, tab, go, onChange }: {
  site: Site; me: Me; days: number; tab: string; go: (n: Record<string, string | undefined>) => void; onChange: () => void;
}) {
  const tabs = [["traffic", "Trafic"], ["search", "Recherche Google"], ["setup", "Installation"]] as const;
  return (
    <>
      <Header title={site.domain} days={tab === "setup" ? undefined : days} go={go} demo={me.demo}
        sub={<a href={`https://${site.domain}`} target="_blank" rel="noreferrer" className="hover:text-ink">Ouvrir le site ↗</a>} />
      <div className="mb-5 -mt-1 overflow-x-auto">
        <Segmented label="Sections du site" value={tab as (typeof tabs)[number][0]} onChange={(v) => go({ tab: v === "traffic" ? undefined : v })} options={tabs} />
      </div>
      {tab === "search" ? <SearchView site={site} me={me} days={days} onChange={onChange} onSetup={() => go({ tab: "setup" })} />
        : tab === "setup" ? <SetupView site={site} me={me} onChange={onChange} />
        : <TrafficView site={site} days={days} onSetup={() => go({ tab: "setup" })} />}
    </>
  );
}

const regionNames = new Intl.DisplayNames(["fr"], { type: "region" });
const countryName = (code: string) => { try { return regionNames.of(code) ?? code; } catch { return code; } };

function TrafficView({ site, days, onSetup }: { site: Site; days: number; onSetup: () => void }) {
  const { data: t, error, reload } = useData<Traffic>(`/api/sites/${site.id}/traffic?days=${days}`);
  const [metric, setMetric] = useState<"visitors" | "pageviews">("visitors");
  const [tech, setTech] = useState<"devices" | "browsers">("devices");
  if (error) return <ErrorLine error={error} retry={reload} />;
  if (!t) return <KpiSkeleton />;
  if (!t.totals.pageviews && !t.previous.pageviews) {
    return (
      <EmptyBox>
        Aucune visite sur cette période. Si vous venez d'ajouter le site, collez le script de suivi puis ouvrez une page du site.{" "}
        <button onClick={onSetup} className="text-ink underline">Voir le script</button>
      </EmptyBox>
    );
  }
  const chart = fillDays(t.daily, t.range.from, t.range.to, (d) => d[metric]);
  const metricName = metric === "visitors" ? "Visiteurs" : "Pages vues";
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Visiteurs" value={fmt(t.totals.visitors)} delta={<Delta now={t.totals.visitors} before={t.previous.visitors} />} active={metric === "visitors"} onClick={() => setMetric("visitors")} />
        <KpiCard label="Pages vues" value={fmt(t.totals.pageviews)} delta={<Delta now={t.totals.pageviews} before={t.previous.pageviews} />} active={metric === "pageviews"} onClick={() => setMetric("pageviews")} />
        <KpiCard label="Pages par visiteur" value={t.totals.visitors ? fmt(t.totals.pageviews / t.totals.visitors, 1) : "—"} />
        <KpiCard label="Venus d'assistants IA" value={fmt(t.totals.ai)} delta={<Delta now={t.totals.ai} before={t.previous.ai} />}
          hint={t.totals.visitors ? `${fmt((t.totals.ai / t.totals.visitors) * 100)} % des visiteurs` : undefined} />
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card title={metricName} action={
          <Segmented label="Série" value={metric} onChange={setMetric} options={[["visitors", "Visiteurs"], ["pageviews", "Pages vues"]] as const} />
        }>
          <BarChart label={metricName} days={chart.days} values={chart.values} />
        </Card>
        <Card title="Provenance">
          <Donut total={t.totals.visitors} totalLabel="visiteurs" parts={t.channels.map((c) => ({ label: CHANNELS[c.key] ?? c.key, value: c.visitors }))} />
        </Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Pages"><ShareList label="Page" rows={t.pages} empty="Aucune page vue sur cette période." /></Card>
        <Card title="Sites référents"><ShareList label="Site" rows={t.referrers} empty="Aucun lien depuis un autre site sur cette période." /></Card>
        <Card title="Assistants IA"><ShareList label="Assistant" rows={t.aiReferrers} empty="Personne n'est arrivé depuis ChatGPT, Perplexity, Claude ou Gemini sur cette période." /></Card>
        <Card title="Pays"><ShareList label="Pays" rows={t.countries} map={countryName} empty="Pays inconnus : placez l'instance derrière Cloudflare pour les obtenir." /></Card>
        <Card title="Appareils" action={<Segmented label="Détail" value={tech} onChange={setTech} options={[["devices", "Type"], ["browsers", "Navigateur"]] as const} />}>
          <ShareList label={tech === "devices" ? "Appareil" : "Navigateur"} rows={t[tech]} empty="Aucune donnée." />
        </Card>
        <Card title="Campagnes"><ShareList label="utm_campaign" rows={t.campaigns} empty="Aucune visite avec un paramètre utm_campaign sur cette période." /></Card>
      </div>
    </div>
  );
}

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
        <button onClick={onSetup} className="text-ink underline">Relier Search Console</button>
      </EmptyBox>
    );
  }
  if (error) return <ErrorLine error={error} retry={reload} />;
  if (!s) return <KpiSkeleton />;
  // Google publie avec 2-3 jours de retard : l'axe s'arrête au dernier jour publié au lieu de tomber à zéro
  const chart = fillDays(s.daily, s.range.from, s.daily.at(-1)?.day ?? s.range.to, (d) => d[metric]);
  const buckets = [["Top 3", 0, 3.5], ["4 à 10", 3.5, 10.5], ["11 à 20", 10.5, 20.5], ["Au-delà", 20.5, Infinity]] as const;
  const queryCols = (label: string) => [
    { label, className: "w-1/2", render: (r: Search["queries"][number]) => r.query },
    { label: "Clics", num: true, render: (r: Search["queries"][number]) => fmt(r.clicks) },
    { label: "Impr.", num: true, render: (r: Search["queries"][number]) => fmt(r.impressions) },
    { label: "Position", num: true, render: (r: Search["queries"][number]) => fmt(r.position, 1) },
  ];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
        <span className={`size-2 rounded-full ${site.sync_error ? "bg-negative" : "bg-accent"}`} aria-hidden />
        <span>{site.synced_at ? `Importé le ${new Date(site.synced_at).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" })}` : "Pas encore importé"} · Google publie avec 2 à 3 jours de retard</span>
        {!me.demo && <Button variant="secondary" onClick={sync} disabled={syncing} className="ml-auto">{syncing ? "Import en cours…" : "Importer maintenant"}</Button>}
      </div>
      {(syncError || site.sync_error) && <p role="alert" className="text-sm text-negative">{syncError || site.sync_error}</p>}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Clics" value={fmt(s.totals.clicks)} delta={<Delta now={s.totals.clicks} before={s.previous.clicks} />} active={metric === "clicks"} onClick={() => setMetric("clicks")} />
        <KpiCard label="Impressions" value={fmt(s.totals.impressions)} delta={<Delta now={s.totals.impressions} before={s.previous.impressions} />} active={metric === "impressions"} onClick={() => setMetric("impressions")} />
        <KpiCard label="Taux de clic" value={s.totals.ctr != null ? `${fmt(s.totals.ctr, 1)} %` : "—"} />
        <KpiCard label="Position moyenne" value={fmt(s.totals.position, 1)} delta={<Delta now={s.totals.position} before={s.previous.position} lowerIsBetter />} hint="Plus c'est bas, mieux c'est" />
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card title={metric === "clicks" ? "Clics" : "Impressions"} action={
          <Segmented label="Série" value={metric} onChange={setMetric} options={[["clicks", "Clics"], ["impressions", "Impressions"]] as const} />
        }>
          <BarChart label={metric === "clicks" ? "Clics" : "Impressions"} days={chart.days} values={chart.values} />
        </Card>
        <Card title="Positions des mots-clés">
          <Donut total={s.queries.length} totalLabel="mots-clés" parts={buckets.map(([label, lo, hi]) => ({ label, value: s.queries.filter((q) => q.position > lo && q.position <= hi).length })).filter((p) => p.value)} />
        </Card>
      </div>
      <Card title="À travailler en priorité" action={<span className="text-sm text-muted">Position 4 à 20, déjà des impressions</span>}>
        <Table rows={s.opportunities.slice(0, 8)} empty="Aucun mot-clé entre la 4e et la 20e position sur cette période." cols={queryCols("Mot-clé")} />
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Mots-clés"><Table rows={s.queries.slice(0, 8)} empty="Aucun mot-clé sur cette période." cols={queryCols("Mot-clé")} /></Card>
        <Card title="Pages">
          <Table rows={s.pages.slice(0, 8)} empty="Aucune page sur cette période." cols={[
            { label: "Page", className: "w-1/2", render: (r) => r.page.replace(/^https?:\/\/[^/]+/, "") || "/" },
            { label: "Clics", num: true, render: (r) => fmt(r.clicks) },
            { label: "Impr.", num: true, render: (r) => fmt(r.impressions) },
            { label: "Position", num: true, render: (r) => fmt(r.position, 1) },
          ]} />
        </Card>
      </div>
    </div>
  );
}

function SettingCard({ title, sub, children }: { title: string; sub: ReactNode; children: ReactNode }) {
  return (
    <Card>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:gap-10">
        <div><h2 className="text-lg font-light">{title}</h2><p className="mt-1 text-sm text-muted">{sub}</p></div>
        <div className="min-w-0">{children}</div>
      </div>
    </Card>
  );
}

function Copyable({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="flex items-start gap-2">
      <pre className="min-w-0 flex-1 overflow-x-auto rounded-xl border border-border bg-raised px-3 py-2.5 font-mono text-xs leading-5"><code>{text}</code></pre>
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
    <div className="space-y-4">
      <SettingCard title="Script de suivi" sub={<>À coller dans le &lt;head&gt; de chaque page. Sans cookie : aucune bannière de consentement n'est nécessaire.</>}>
        <Copyable text={`<script defer src="${location.origin}/script.js" data-site="${site.domain}"></script>`} />
        <p className="mt-3 text-xs text-muted">Pour compter une action : <code className="font-mono">searchtide("inscription")</code> en JavaScript, ou l'attribut <code className="font-mono">data-searchtide="clic-cta"</code> sur un bouton.</p>
      </SettingCard>
      <SettingCard title="Google Search Console" sub="Mots-clés, clics, impressions et position de chaque page. Importés automatiquement toutes les 6 heures.">
        {!me.gsc ? (
          <p className="text-sm">Non configuré sur cette instance : renseignez <code className="font-mono text-xs">GOOGLE_SERVICE_ACCOUNT_JSON</code> puis redémarrez (voir la documentation).</p>
        ) : error ? <p role="alert" className="text-sm text-negative">{error}</p> : (
          <label className="block text-sm">Propriété Search Console
            <select className={`${inputCls} mt-2`} value={site.gsc_property ?? ""} disabled={me.demo} onChange={(e) => link(e.target.value)}>
              <option value="">Non reliée</option>
              {site.gsc_property && !props?.includes(site.gsc_property) && <option value={site.gsc_property}>{site.gsc_property}</option>}
              {props?.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            {props?.length === 0 && <span className="mt-2 block text-xs text-muted">Aucune propriété visible : ajoutez l'email du compte de service comme utilisateur du site dans Search Console.</span>}
          </label>
        )}
      </SettingCard>
      <SettingCard title="Agents IA" sub="Vos agents (Claude, Cursor…) lisent les statistiques par le serveur MCP de l'instance, avec la clé API_KEY.">
        <Copyable text={`claude mcp add --transport http searchtide ${location.origin}/mcp --header "Authorization: Bearer VOTRE_CLE"`} />
      </SettingCard>
      {!me.demo && (
        <SettingCard title="Supprimer le site" sub="Efface le site et toutes ses statistiques. Définitif.">
          <button onClick={remove} className="h-9 rounded-full border border-negative/40 px-4 text-sm font-medium text-negative hover:bg-negative-bg">Supprimer {site.domain}</button>
        </SettingCard>
      )}
    </div>
  );
}
