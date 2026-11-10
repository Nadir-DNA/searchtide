import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ActivateLink } from "./modules/ActivatePrompt";
import { api, AuthError, type Overview as OverviewData, type Search, type Site, type Traffic } from "./api";
import { BarChart, Donut, fillDays } from "./chart";
import { CrmView } from "./modules/crm";
import { PubsView } from "./modules/publications";
import { ReportView } from "./modules/notifications/ReportView";
import { ManageProject, ProjectView, type Project } from "./projects";
import { Onboarding, SKIP_KEY } from "./onboarding";
import { PortfolioView } from "./portefeuille";
import { ConnectionsView } from "./connections";
import { AgentsView } from "./agents";
import { DashboardView, type Dashboards } from "./dashboard";
import { SettingsView } from "./settings";
import { SetupView, TrafficView } from "./modules/analytics";
import { SearchView } from "./modules/google";
import { Button, Card, Delta, EmptyBox, Icon, KpiCard, Mark, Segmented, ShareList, Skeleton, Svg, Table, fmt, inputCls } from "./ui";

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
  const [totp, setTotp] = useState(false);
  useEffect(() => { api<{ totp: boolean }>("/api/auth-config").then((r) => setTotp(r.totp)).catch(() => {}); }, []);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try { await api("/api/login", { method: "POST", json: { password: f.get("password"), code: f.get("code") ?? "" } }); location.reload(); }
    catch (err) { setError((err as Error).message); }
  }
  return (
    <main className="grid min-h-screen place-items-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-border bg-surface p-8">
        <div className="mb-8 flex items-center gap-2.5"><Mark className="size-8" /><span className="text-lg font-medium tracking-tight">Searchtide</span></div>
        <h1 className="text-[28px] font-light">Connexion</h1>
        <p className="mt-1 mb-6 text-sm text-muted">Le mot de passe est défini par ADMIN_PASSWORD sur votre instance.</p>
        <label className="block text-sm">Mot de passe
          <input name="password" type="password" autoFocus required autoComplete="current-password" className={`${inputCls} mt-2`} />
        </label>
        {totp && (
          <label className="mt-4 block text-sm">Code de l'application d'authentification
            <input name="code" inputMode="numeric" pattern="[0-9 ]{6,7}" autoComplete="one-time-code" required placeholder="123 456" className={`${inputCls} mt-2`} />
          </label>
        )}
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
  const [projects, setProjects] = useState<Project[]>([]);
  const [menu, setMenu] = useState(false);
  const load = useCallback(() => api<Site[]>("/api/sites").then(setSites).catch((e) => e instanceof AuthError && onLogout()), [onLogout]);
  const loadProjects = useCallback(() => api<Project[]>("/api/projects?days=1").then(setProjects).catch(() => {}), []);
  const [dash, setDash] = useState<Dashboards | null>(null);
  const loadDash = useCallback(() => { if (!me.demo) api<Dashboards>("/api/dashboards").then(setDash).catch(() => {}); }, [me.demo]);
  useEffect(() => { load(); loadProjects(); loadDash(); }, [load, loadProjects, loadDash]);
  const days = Number(q.days) || 28;
  const site = sites?.find((s) => s.domain === q.site);
  const nav = (next: Record<string, string | undefined>) => { setMenu(false); go(next); };
  // Retour d'une autorisation (Stripe…) : on ouvre l'écran Connexions avec le résultat
  useEffect(() => {
    if (q.connexion) { history.replaceState(null, "", "/?view=connections"); }
  }, [q.connexion]);
  // Réinitialise les filtres propres à chaque vue
  const home = { site: undefined, tab: undefined, view: undefined, id: undefined, q: undefined, project: undefined, source: undefined, month: undefined };

  const sidebar = (
    <nav aria-label="Navigation" className="flex flex-1 flex-col gap-1 px-4 pb-5">
      {me.demo || !dash ? <NavItem icon={Icon.grid} active={!q.site && !q.view} onClick={() => nav(home)}>Vue d'ensemble</NavItem>
        : dash.dashboards.map((d, i) => (
          <NavItem key={d.id} icon={Icon.grid} active={!q.site && (q.view === "page" ? q.id === d.id : !q.view && i === 0)} onClick={() => nav(i === 0 ? home : { ...home, view: "page", id: d.id })}>
            <span className="truncate">{d.name}</span>
          </NavItem>
        ))}
      {!me.demo && <NavItem icon={Icon.plus} active={false} onClick={async () => {
        const name = prompt("Nom de la nouvelle page");
        if (name?.trim()) { const d = await api<{ id: string }>("/api/dashboards", { method: "POST", json: { name } }); loadDash(); nav({ ...home, view: "page", id: d.id }); }
      }}>Nouvelle page</NavItem>}
      <div className="mt-6 mb-1 px-3 text-xs text-muted">Outils</div>
      <NavItem icon={Icon.grid} active={q.view === "portfolio"} onClick={() => nav({ ...home, view: "portfolio" })}>Portefeuille</NavItem>
      {!me.demo && <NavItem icon={Icon.users} active={q.view === "crm"} onClick={() => nav({ ...home, view: "crm" })}>Contacts</NavItem>}
      {!me.demo && <NavItem icon={Icon.calendar} active={q.view === "pubs"} onClick={() => nav({ ...home, view: "pubs" })}>Publications</NavItem>}
      <NavItem icon={Icon.mail} active={q.view === "report"} onClick={() => nav({ ...home, view: "report" })}>Rapport hebdo</NavItem>
      {!me.demo && <NavItem icon={Icon.bot} active={q.view === "agents"} onClick={() => nav({ ...home, view: "agents" })}>Agents IA</NavItem>}
      {!me.demo && <NavItem icon={Icon.book} active={q.view === "start"} onClick={() => nav({ ...home, view: "start" })}>Démarrage</NavItem>}
      {!me.demo && <NavItem icon={Icon.link} active={q.view === "connections"} onClick={() => nav({ ...home, view: "connections" })}>Connexions</NavItem>}
      <div className="mt-6 mb-1 px-3 text-xs text-muted">Projets</div>
      {projects.map((p) => (
        <NavItem key={p.id} icon={<circle cx="8" cy="8" r="3" fill={p.color ?? "currentColor"} stroke="none" />} active={q.view === "project" && q.id === p.id} onClick={() => nav({ ...home, view: "project", id: p.id })}>
          <span className="truncate">{p.name}</span>
        </NavItem>
      ))}
      <NavItem icon={Icon.plus} active={q.view === "newproject"} onClick={() => nav({ ...home, view: "newproject" })}>Nouveau projet</NavItem>
      <div className="mt-6 mb-1 px-3 text-xs text-muted">Sites</div>
      {sites?.map((s) => (
        <NavItem key={s.id} icon={Icon.globe} active={s.domain === q.site} onClick={() => nav({ site: s.domain, view: undefined })}>
          <span className="truncate">{s.domain}</span>
          {s.today > 0 && <span className="num ml-auto text-xs text-muted" title="Visiteurs aujourd'hui">{fmt(s.today)}</span>}
        </NavItem>
      ))}
      {!me.demo && <NavItem icon={Icon.plus} active={q.view === "add"} onClick={() => nav({ site: undefined, view: "add" })}>Ajouter un site</NavItem>}
      <div className="mt-auto space-y-1 pt-6">
        <NavItem icon={Icon.gear} active={q.view === "settings"} onClick={() => nav({ ...home, view: "settings" })}>Réglages</NavItem>
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
        <div className="flex h-20 items-center gap-2.5 px-7"><Mark className="size-7" /><span className="text-lg font-medium tracking-tight">Searchtide</span></div>
        {sidebar}
      </aside>
      {menu && (
        <div className="fixed inset-0 z-20 flex flex-col bg-ground md:hidden">
          <div className="flex h-14 items-center justify-between px-4">
            <span className="flex items-center gap-2.5"><Mark className="size-7" /><span className="text-lg font-medium tracking-tight">Searchtide</span></span>
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
          : q.view === "crm" ? <CrmView tab={q.tab ?? ""} go={go} q={q} />
          : q.view === "pubs" ? <PubsView q={q} go={go} />
          : q.view === "report" ? <ReportView />
          : q.view === "settings" ? <SettingsView />
          : q.view === "agents" ? <AgentsView />
          : q.view === "connections" ? <ConnectionsView />
          : q.view === "start" ? <Onboarding go={go} />
          : q.view === "portfolio" ? <PortfolioView days={days} go={go} />
          : q.view === "project" && q.id ? <ProjectView key={q.id} id={q.id} days={days} go={go} />
          : q.view === "newproject" ? <ManageProject project={null} onClose={() => go(home)} onSaved={(p) => { loadProjects(); if (p) go({ ...home, view: "project", id: p.id }); }} />
          : q.view === "add" ? <AddSite onAdded={(s) => { load(); go({ site: s.domain, tab: "setup", view: undefined }); }} />
          : site ? <SiteView key={site.id} site={site} me={me} days={days} tab={q.tab ?? "traffic"} go={go} onChange={load} />
          : !sites.length && !projects.length && !me.demo && !localStorage.getItem(SKIP_KEY) ? <Onboarding go={go} />
          : me.demo ? <Overview days={days} demo={me.demo} go={go} />
          : !dash ? <KpiSkeleton />
          : (() => {
            const d = (q.view === "page" && dash.dashboards.find((x) => x.id === q.id)) || dash.dashboards[0];
            return <DashboardView key={d.id} dash={d} catalog={dash.catalog} sizes={dash.sizes} days={days} go={go} onChanged={loadDash} />;
          })()}
      </div>
    </div>
  );
}

function NavItem({ icon, active, onClick, children }: { icon: ReactNode; active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick} aria-current={active ? "page" : undefined}
      className={`flex h-9 w-full items-center gap-3 rounded-lg px-3 text-left text-sm transition-colors ${active ? "bg-active text-ink" : "text-muted hover:bg-raised hover:text-ink"}`}>
      <Svg>{icon}</Svg>{children}
    </button>
  );
}

export function useData<T>(url: string) {
  const [state, setState] = useState<{ data: T | null; error: string }>({ data: null, error: "" });
  const reload = useCallback(() => {
    api<T>(url).then((data) => setState({ data, error: "" })).catch((e) => setState((s) => ({ ...s, error: e.message })));
  }, [url]);
  useEffect(reload, [reload]);
  return { ...state, reload };
}

export function Header({ title, sub, days, go, demo, children }: {
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

export function ErrorLine({ error, retry }: { error: string; retry: () => void }) {
  return <EmptyBox>Impossible de charger les données : {error}. <button onClick={retry} className="text-ink underline">Réessayer</button></EmptyBox>;
}

export function KpiSkeleton() {
  return <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <div key={i} className="space-y-3 rounded-2xl border border-border bg-surface p-5"><Skeleton className="h-4 w-20" /><Skeleton className="h-9 w-28" /></div>)}</div>;
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
            <KpiCard label="Visites" value={fmt(visitors)} delta={<Delta now={visitors} before={prev} />} hint="Visiteurs uniques de chaque jour, additionnés" />
            <KpiCard label="Pages vues" value={fmt(sum((s) => s.traffic.pageviews))} delta={<Delta now={sum((s) => s.traffic.pageviews)} before={sum((s) => s.trafficPrev.pageviews)} />} />
            <KpiCard label="Venus d'assistants IA" value={fmt(sum((s) => s.traffic.ai))} delta={<Delta now={sum((s) => s.traffic.ai)} before={sum((s) => s.trafficPrev.ai)} />} />
            <KpiCard label="Clics Google" value={linked.length ? fmt(linked.reduce((n, s) => n + s.search!.clicks, 0)) : "—"}
              hint={linked.length ? `${linked.length} site${linked.length > 1 ? "s" : ""} relié${linked.length > 1 ? "s" : ""} à Search Console` : "Aucun site relié à Search Console"} />
          </div>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <Card title="Visiteurs par jour, tous sites" action={<Delta now={visitors} before={prev} />}>
              <BarChart label="Visiteurs par jour, tous sites" {...fillDays(o.daily, o.range.from, o.range.to, (d) => d.visitors)} />
            </Card>
            <Card title="Répartition par site">
              {visitors ? <Donut total={visitors} totalLabel="visites" parts={sites!.map((s) => ({ label: s.domain, value: s.traffic.visitors }))} />
                : <EmptyBox>Aucune visite sur la période.</EmptyBox>}
            </Card>
          </div>
          <Card title="Sites">
            <Table rows={sites!} onRow={(s) => go({ site: s.domain })} empty="" cols={[
              { label: "Site", className: "w-1/3", render: (s) => <span className="flex items-center gap-2.5"><span className={`size-2 shrink-0 rounded-full ${s.today ? "bg-accent" : "bg-control"}`} title={s.today ? "Visites aujourd'hui" : "Aucune visite aujourd'hui"} />{s.domain}</span> },
              { label: "Visites", num: true, render: (s) => fmt(s.traffic.visitors) },
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
  // L'onglet Recherche n'existe que si le module Google est actif et connecté (la démonstration le montre toujours)
  const tabs = [["traffic", "Trafic"], ...(me.gsc || me.demo ? [["search", "Recherche Google"] as const] : []), ["setup", "Installation"]] as const;
  return (
    <>
      <Header title={site.domain} days={tab === "setup" ? undefined : days} go={go} demo={me.demo}
        sub={<a href={`https://${site.domain}`} target="_blank" rel="noreferrer" className="hover:text-ink">Ouvrir le site ↗</a>} />
      <div className="mb-5 -mt-1 overflow-x-auto">
        <Segmented label="Sections du site" value={tab as (typeof tabs)[number][0]} onChange={(v) => go({ tab: v === "traffic" ? undefined : v })} options={tabs} />
      </div>
      {tab === "search" ? <SearchView site={site} me={me} days={days} onChange={onChange} onSetup={() => go({ tab: "setup" })} />
        : tab === "setup" ? <SetupView site={site} me={me} onChange={onChange} go={go} />
        : <TrafficView site={site} days={days} onSetup={() => go({ tab: "setup" })} />}
    </>
  );
}

